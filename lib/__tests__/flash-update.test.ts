import { describe, expect, it } from "vitest";
// Imported from the pure module, not lib/flash — keeps the suite off
// @upstash/redis and mirrors how app/app/page.tsx has to import it.
import {
  buildFlashUpdate,
  normalizeFlashPrice,
  flashUpdateAxis,
  isFlashOrderUpdatable,
  limitPriceOf,
  triggerPriceOf,
  FLASH_CANCELLABLE_STATUSES,
  FLASH_UPDATABLE_STATUSES,
  type FlashOrderStatus,
  type FlashOrderType,
} from "../flashUpdate";
import type { FlashOrder } from "../flash";

// Flash validates the update message byte-for-byte and returns a bare 404 on
// a mismatch — indistinguishable from an order that never existed. That makes
// these assertions the only cheap way to prove the format without a funded
// wallet, so they are written against the literal strings in Flash's docs
// (https://flash.definitive.fi/docs/updating-orders), not against the
// implementation's own constants.

const ORDER_ID = "887ccf13-1f4a-4a1e-9b1c-2c9f0d5e7a10";
const ISSUED_AT = "2026-08-21T09:15:30.123Z";

function orderStub(over: Partial<FlashOrder> = {}): FlashOrder {
  return {
    orderId: ORDER_ID,
    orderType: "stop-loss",
    side: "sell",
    status: "ORDER_STATUS_ACCEPTED",
    closeReason: null,
    funderAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    targetAsset: { id: "", name: "", address: "", ticker: "ETH", chain: { id: "", name: "", namespace: "" } },
    contraAsset: { id: "", name: "", address: "", ticker: "USDC", chain: { id: "", name: "", namespace: "" } },
    qty: "2",
    filled: null,
    limitNotionalPrice: null,
    limitCrossPrice: null,
    trigger: { notionalPrice: "1800", triggerType: "lower" },
    brackets: null,
    maxPriceImpact: null,
    twapBucketCount: null,
    placedAt: "2026-08-21T09:00:00.000Z",
    acceptedAt: null,
    closedAt: null,
    ...over,
  };
}

describe("buildFlashUpdate — message bytes", () => {
  it("builds the stop-loss example from Flash's docs verbatim", () => {
    const built = buildFlashUpdate({
      orderId: ORDER_ID,
      trigger: { price: "1800", basis: "notional", triggerType: "lower" },
      issuedAt: ISSUED_AT,
    });
    expect(built?.updateMessage).toBe(
      `Definitive Flash — Update Order\nOrder: ${ORDER_ID}\nIssued At: ${ISSUED_AT}\nTrigger Lower Notional Price: 1800`,
    );
  });

  it("uses an em dash and omits the v1 that the cancel header carries", () => {
    const built = buildFlashUpdate({
      orderId: ORDER_ID,
      limit: { price: "4000", basis: "notional" },
      issuedAt: ISSUED_AT,
    });
    const header = built!.updateMessage.split("\n")[0];
    expect(header).toBe("Definitive Flash — Update Order");
    expect(header).not.toContain("v1");
    expect(header).not.toContain("-"); // an ASCII hyphen here is rejected
  });

  it("orders the limit line before the trigger line when both are present", () => {
    const built = buildFlashUpdate({
      orderId: ORDER_ID,
      limit: { price: "4000", basis: "notional" },
      trigger: { price: "3000", basis: "notional", triggerType: "lower" },
      issuedAt: ISSUED_AT,
    });
    const lines = built!.updateMessage.split("\n");
    expect(lines[3]).toBe("Limit Notional Price: 4000");
    expect(lines[4]).toBe("Trigger Lower Notional Price: 3000");
  });

  it("names the basis and direction in the trigger line", () => {
    const upper = buildFlashUpdate({
      orderId: ORDER_ID,
      trigger: { price: "0.002", basis: "cross", triggerType: "upper" },
      issuedAt: ISSUED_AT,
    });
    expect(upper!.updateMessage).toContain("Trigger Upper Cross Price: 0.002");

    const lower = buildFlashUpdate({
      orderId: ORDER_ID,
      trigger: { price: "1800", basis: "notional", triggerType: "lower" },
      issuedAt: ISSUED_AT,
    });
    expect(lower!.updateMessage).toContain("Trigger Lower Notional Price: 1800");
  });

  it("names the basis in the limit line", () => {
    const cross = buildFlashUpdate({
      orderId: ORDER_ID,
      limit: { price: "0.0004", basis: "cross" },
      issuedAt: ISSUED_AT,
    });
    expect(cross!.updateMessage).toContain("Limit Cross Price: 0.0004");
  });

  it("uses single newlines, no CRLF, no trailing newline, no blank lines", () => {
    const built = buildFlashUpdate({
      orderId: ORDER_ID,
      limit: { price: "4000", basis: "notional" },
      trigger: { price: "3000", basis: "notional", triggerType: "lower" },
      issuedAt: ISSUED_AT,
    });
    const msg = built!.updateMessage;
    expect(msg).not.toContain("\r");
    expect(msg.endsWith("\n")).toBe(false);
    expect(msg.split("\n").some(l => l === "")).toBe(false);
  });

  it("returns null when neither price is supplied — nothing to sign", () => {
    expect(buildFlashUpdate({ orderId: ORDER_ID, issuedAt: ISSUED_AT })).toBeNull();
  });

  it("defaults Issued At to now in RFC3339 with sub-second precision", () => {
    const built = buildFlashUpdate({ orderId: ORDER_ID, limit: { price: "1", basis: "notional" } });
    const stamp = built!.updateMessage.split("\n")[2].replace("Issued At: ", "");
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Math.abs(Date.now() - Date.parse(stamp))).toBeLessThan(5_000);
  });
});

describe("buildFlashUpdate — body matches the signed bytes", () => {
  it("sends the decimal byte-identical to the message, never renormalized", () => {
    const built = buildFlashUpdate({
      orderId: ORDER_ID,
      limit: { price: "4000", basis: "notional" },
      issuedAt: ISSUED_AT,
    });
    expect(built!.body.limitNotionalPrice).toBe("4000");
    expect(built!.updateMessage).toContain("Limit Notional Price: 4000");
    // the classic failure: "4000" signed, 4000.0 sent
    expect(built!.body.limitNotionalPrice).not.toBe("4000.0");
  });

  it("keeps a trailing-zero decimal exactly as given, in both places", () => {
    const built = buildFlashUpdate({
      orderId: ORDER_ID,
      trigger: { price: "1800.50", basis: "notional", triggerType: "lower" },
      issuedAt: ISSUED_AT,
    });
    expect(built!.body.trigger?.notionalPrice).toBe("1800.50");
    expect(built!.updateMessage).toContain("Trigger Lower Notional Price: 1800.50");
  });

  it("puts the price on the field matching its basis, and only that field", () => {
    const notional = buildFlashUpdate({ orderId: ORDER_ID, limit: { price: "4000", basis: "notional" }, issuedAt: ISSUED_AT });
    expect(notional!.body.limitNotionalPrice).toBe("4000");
    expect(notional!.body.limitCrossPrice).toBeUndefined();

    const cross = buildFlashUpdate({ orderId: ORDER_ID, limit: { price: "0.002", basis: "cross" }, issuedAt: ISSUED_AT });
    expect(cross!.body.limitCrossPrice).toBe("0.002");
    expect(cross!.body.limitNotionalPrice).toBeUndefined();
  });

  it("carries triggerType through unchanged — Flash fixes it for the order's life", () => {
    const built = buildFlashUpdate({
      orderId: ORDER_ID,
      trigger: { price: "5000", basis: "notional", triggerType: "upper" },
      issuedAt: ISSUED_AT,
    });
    expect(built!.body.trigger?.triggerType).toBe("upper");
    expect(built!.body.trigger?.crossPrice).toBeUndefined();
  });
});

describe("normalizeFlashPrice", () => {
  it("accepts what a person actually types", () => {
    expect(normalizeFlashPrice("3200")).toBe("3200");
    expect(normalizeFlashPrice(" 3200 ")).toBe("3200");
    expect(normalizeFlashPrice("$3200")).toBe("3200");
    expect(normalizeFlashPrice("3,200")).toBe("3200");
    expect(normalizeFlashPrice("$3,200.50")).toBe("3200.50");
    expect(normalizeFlashPrice("0.0004")).toBe("0.0004");
  });

  it("preserves the decimal exactly rather than reformatting it", () => {
    expect(normalizeFlashPrice("4000.00")).toBe("4000.00");
    expect(normalizeFlashPrice("0.500")).toBe("0.500");
  });

  it("refuses anything that is not a positive decimal", () => {
    for (const bad of ["", "  ", "abc", "3200 NVDA", "-100", "0", "1e5", "3.2.1", "$", "0.002 NVDA"]) {
      expect(normalizeFlashPrice(bad)).toBeNull();
    }
  });

  it("refuses ambiguous comma placement rather than guessing", () => {
    // "3,2" is 3.2 to most of continental Europe. Stripping commas blindly
    // would sign it as 32 — a 10x error on a price about to be committed.
    for (const ambiguous of ["3,2", "1,,000", "1,00", "3,20", ",100", "1,000,00"]) {
      expect(normalizeFlashPrice(ambiguous)).toBeNull();
    }
  });

  it("strips commas only from well-formed thousands grouping", () => {
    expect(normalizeFlashPrice("1,000")).toBe("1000");
    expect(normalizeFlashPrice("12,345,678.90")).toBe("12345678.90");
  });
});

describe("updatability rules", () => {
  it("does not treat PENDING as updatable, though it is cancellable", () => {
    expect(FLASH_CANCELLABLE_STATUSES.has("ORDER_STATUS_PENDING")).toBe(true);
    expect(FLASH_UPDATABLE_STATUSES.has("ORDER_STATUS_PENDING")).toBe(false);
    expect(isFlashOrderUpdatable(orderStub({ status: "ORDER_STATUS_PENDING" }))).toBe(false);
  });

  it("allows the two live statuses", () => {
    for (const status of ["ORDER_STATUS_ACCEPTED", "ORDER_STATUS_PARTIALLY_FILLED"] as FlashOrderStatus[]) {
      expect(isFlashOrderUpdatable(orderStub({ status }))).toBe(true);
    }
  });

  it("refuses terminal statuses", () => {
    for (const status of [
      "ORDER_STATUS_FILLED", "ORDER_STATUS_CANCELLED",
      "ORDER_STATUS_REJECTED", "ORDER_STATUS_TERMINATED",
    ] as FlashOrderStatus[]) {
      expect(isFlashOrderUpdatable(orderStub({ status }))).toBe(false);
    }
  });

  it("maps each order type to the axis Flash accepts for it", () => {
    expect(flashUpdateAxis({ orderType: "limit" })).toBe("limit");
    for (const orderType of ["stop", "stop-loss", "take-profit"] as FlashOrderType[]) {
      expect(flashUpdateAxis({ orderType })).toBe("trigger");
    }
  });

  it("refuses the types Flash rejects with 422", () => {
    for (const orderType of ["twap", "market", "bracket"] as FlashOrderType[]) {
      expect(flashUpdateAxis({ orderType })).toBeNull();
      expect(isFlashOrderUpdatable(orderStub({ orderType }))).toBe(false);
    }
  });
});

describe("basis readers", () => {
  it("reads a notional trigger with its basis", () => {
    expect(triggerPriceOf({ notionalPrice: "1800", triggerType: "lower" }))
      .toEqual({ price: "1800", basis: "notional", triggerType: "lower" });
  });

  it("reads a cross trigger placed by another Flash client", () => {
    expect(triggerPriceOf({ crossPrice: "0.002", triggerType: "upper" }))
      .toEqual({ price: "0.002", basis: "cross", triggerType: "upper" });
  });

  it("returns null for absent or empty triggers", () => {
    expect(triggerPriceOf(null)).toBeNull();
    expect(triggerPriceOf(undefined)).toBeNull();
    expect(triggerPriceOf({ triggerType: "lower" })).toBeNull();
  });

  it("reads a limit price in whichever basis the order carries", () => {
    expect(limitPriceOf({ limitNotionalPrice: "4000", limitCrossPrice: null }))
      .toEqual({ price: "4000", basis: "notional" });
    expect(limitPriceOf({ limitNotionalPrice: null, limitCrossPrice: "0.0004" }))
      .toEqual({ price: "0.0004", basis: "cross" });
    expect(limitPriceOf({ limitNotionalPrice: null, limitCrossPrice: null })).toBeNull();
  });
});
