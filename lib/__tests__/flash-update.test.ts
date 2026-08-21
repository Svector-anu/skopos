import { describe, expect, it } from "vitest";
// Imported from the pure module, not lib/flash — keeps the suite off
// @upstash/redis and mirrors how app/app/page.tsx has to import it.
import {
  buildFlashUpdate,
  buildFlashCancelMessage,
  normalizeFlashPrice,
  flashUpdateAxis,
  isFlashOrderUpdatable,
  limitPriceOf,
  triggerPriceOf,
  FLASH_CANCELLABLE_STATUSES,
  FLASH_UPDATABLE_STATUSES,
  FLASH_UPDATE_INTENT_RE,
  validateFlashUpdateBody,
  flashUpdateErrorMessage,
  type FlashOrderStatus,
  type FlashOrderType,
} from "../flashUpdate";
import { validateBracket, isBracketableOrderType } from "../flashBracket";
import type { FlashOrder } from "../flash";

// Flash validates the update message byte-for-byte and answers a mismatch
// with a bare 404 — indistinguishable from an order that never existed. That
// makes these assertions the only cheap way to prove the format without a
// funded wallet, so they are written against the literal strings in Flash's
// docs (https://flash.definitive.fi/docs/updating-orders), not against the
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

describe("buildFlashUpdate", () => {
  describe("message bytes", () => {
    it("should reproduce Flash's documented stop-loss message verbatim", () => {
      // #given a lower notional trigger and a pinned issue stamp
      const trigger = { price: "1800", basis: "notional", triggerType: "lower" } as const;

      // #when the update is built
      const built = buildFlashUpdate({ orderId: ORDER_ID, trigger, issuedAt: ISSUED_AT });

      // #then it matches the doc example byte for byte
      expect(built?.updateMessage).toBe(
        `Definitive Flash — Update Order\nOrder: ${ORDER_ID}\nIssued At: ${ISSUED_AT}\nTrigger Lower Notional Price: 1800`,
      );
    });

    it("should head the message with an em dash and no v1, unlike the cancel header", () => {
      // #given any updatable price
      const limit = { price: "4000", basis: "notional" } as const;

      // #when the update is built
      const built = buildFlashUpdate({ orderId: ORDER_ID, limit, issuedAt: ISSUED_AT });

      // #then the header omits the "v1" that cancel carries, and uses U+2014
      expect(built!.updateMessage.split("\n")[0]).toBe("Definitive Flash — Update Order");
    });

    it("should place the limit line before the trigger line when both are present", () => {
      // #given both a limit and a trigger price
      const limit = { price: "4000", basis: "notional" } as const;
      const trigger = { price: "3000", basis: "notional", triggerType: "lower" } as const;

      // #when the update is built
      const built = buildFlashUpdate({ orderId: ORDER_ID, limit, trigger, issuedAt: ISSUED_AT });

      // #then the limit line precedes the trigger line
      expect(built!.updateMessage.split("\n").slice(3)).toEqual([
        "Limit Notional Price: 4000",
        "Trigger Lower Notional Price: 3000",
      ]);
    });

    it("should name direction and basis in the trigger line", () => {
      // #given an upper trigger priced in cross basis
      const trigger = { price: "0.002", basis: "cross", triggerType: "upper" } as const;

      // #when the update is built
      const built = buildFlashUpdate({ orderId: ORDER_ID, trigger, issuedAt: ISSUED_AT });

      // #then both words appear in the trigger line
      expect(built!.updateMessage).toContain("Trigger Upper Cross Price: 0.002");
    });

    it("should name the basis in the limit line", () => {
      // #given a limit priced in cross basis
      const limit = { price: "0.0004", basis: "cross" } as const;

      // #when the update is built
      const built = buildFlashUpdate({ orderId: ORDER_ID, limit, issuedAt: ISSUED_AT });

      // #then the line is labelled Cross rather than Notional
      expect(built!.updateMessage).toContain("Limit Cross Price: 0.0004");
    });

    it("should join lines with single newlines and no trailing newline", () => {
      // #given both prices, the longest message this builds
      const limit = { price: "4000", basis: "notional" } as const;
      const trigger = { price: "3000", basis: "notional", triggerType: "lower" } as const;

      // #when the update is built
      const msg = buildFlashUpdate({ orderId: ORDER_ID, limit, trigger, issuedAt: ISSUED_AT })!.updateMessage;

      // #then CRLF, blank lines and a trailing newline are all absent
      expect({ crlf: msg.includes("\r"), blank: msg.split("\n").includes(""), trailing: msg.endsWith("\n") })
        .toEqual({ crlf: false, blank: false, trailing: false });
    });

    it("should stamp Issued At as RFC3339 with sub-second precision by default", () => {
      // #given no explicit issuedAt
      // #when the update is built
      const built = buildFlashUpdate({ orderId: ORDER_ID, limit: { price: "1", basis: "notional" } });

      // #then the stamp carries milliseconds, so two updates in one second differ
      const stamp = built!.updateMessage.split("\n")[2].replace("Issued At: ", "");
      expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("should stamp Issued At close to now, for the one-minute freshness window", () => {
      // #given no explicit issuedAt
      // #when the update is built
      const built = buildFlashUpdate({ orderId: ORDER_ID, limit: { price: "1", basis: "notional" } });

      // #then the stamp is current rather than fixed at module load
      const stamp = built!.updateMessage.split("\n")[2].replace("Issued At: ", "");
      expect(Math.abs(Date.now() - Date.parse(stamp))).toBeLessThan(5_000);
    });

    it("should refuse to build when neither price is supplied", () => {
      // #given no limit and no trigger
      // #when the update is built
      const built = buildFlashUpdate({ orderId: ORDER_ID, issuedAt: ISSUED_AT });

      // #then there is nothing to sign, so nothing is returned
      expect(built).toBeNull();
    });
  });

  describe("body agreement with the signed bytes", () => {
    it("should send the decimal byte-identical to the signed message", () => {
      // #given a price whose formatting must survive verbatim
      const limit = { price: "4000", basis: "notional" } as const;

      // #when the update is built
      const built = buildFlashUpdate({ orderId: ORDER_ID, limit, issuedAt: ISSUED_AT });

      // #then the body value is "4000", never a renormalized "4000.0"
      expect(built!.body.limitNotionalPrice).toBe("4000");
    });

    it("should preserve a trailing-zero decimal in the message", () => {
      // #given a price with a significant trailing zero
      const trigger = { price: "1800.50", basis: "notional", triggerType: "lower" } as const;

      // #when the update is built
      const built = buildFlashUpdate({ orderId: ORDER_ID, trigger, issuedAt: ISSUED_AT });

      // #then the message repeats it exactly as given
      expect(built!.updateMessage).toContain("Trigger Lower Notional Price: 1800.50");
    });

    it("should preserve a trailing-zero decimal in the body", () => {
      // #given the same price
      const trigger = { price: "1800.50", basis: "notional", triggerType: "lower" } as const;

      // #when the update is built
      const built = buildFlashUpdate({ orderId: ORDER_ID, trigger, issuedAt: ISSUED_AT });

      // #then the body agrees with the message
      expect(built!.body.trigger?.notionalPrice).toBe("1800.50");
    });

    it("should populate only the limit field matching the basis", () => {
      // #given a cross-basis limit price
      const limit = { price: "0.002", basis: "cross" } as const;

      // #when the update is built
      const built = buildFlashUpdate({ orderId: ORDER_ID, limit, issuedAt: ISSUED_AT });

      // #then the notional field stays absent — the two are mutually exclusive
      expect({ cross: built!.body.limitCrossPrice, notional: built!.body.limitNotionalPrice })
        .toEqual({ cross: "0.002", notional: undefined });
    });

    it("should populate only the trigger field matching the basis", () => {
      // #given a notional-basis trigger price
      const trigger = { price: "5000", basis: "notional", triggerType: "upper" } as const;

      // #when the update is built
      const built = buildFlashUpdate({ orderId: ORDER_ID, trigger, issuedAt: ISSUED_AT });

      // #then the cross field stays absent
      expect({ notional: built!.body.trigger?.notionalPrice, cross: built!.body.trigger?.crossPrice })
        .toEqual({ notional: "5000", cross: undefined });
    });

    it("should carry triggerType through unchanged, since Flash fixes it for the order's life", () => {
      // #given an upper trigger
      const trigger = { price: "5000", basis: "notional", triggerType: "upper" } as const;

      // #when the update is built
      const built = buildFlashUpdate({ orderId: ORDER_ID, trigger, issuedAt: ISSUED_AT });

      // #then the direction is echoed rather than re-derived
      expect(built!.body.trigger?.triggerType).toBe("upper");
    });
  });
});

describe("normalizeFlashPrice", () => {
  it("should accept the shapes a person actually types", () => {
    // #given plain, padded, dollar-prefixed and grouped inputs
    const typed = ["3200", " 3200 ", "$3200", "3,200"];

    // #when each is normalized
    const out = typed.map(normalizeFlashPrice);

    // #then all resolve to the same canonical decimal
    expect(out).toEqual(["3200", "3200", "3200", "3200"]);
  });

  it("should preserve the decimal exactly rather than reformatting it", () => {
    // #given decimals whose formatting is significant to the signature
    const typed = ["4000.00", "0.500", "0.0004"];

    // #when each is normalized
    const out = typed.map(normalizeFlashPrice);

    // #then none are rounded, padded or trimmed
    expect(out).toEqual(["4000.00", "0.500", "0.0004"]);
  });

  it("should strip commas only from well-formed thousands grouping", () => {
    // #given valid grouped numbers
    const typed = ["1,000", "12,345,678.90"];

    // #when each is normalized
    const out = typed.map(normalizeFlashPrice);

    // #then the separators are removed and the value is unchanged
    expect(out).toEqual(["1000", "12345678.90"]);
  });

  it("should refuse ambiguous comma placement rather than guessing", () => {
    // #given inputs where a comma is not an unambiguous thousands separator.
    // "3,2" is 3.2 to most of continental Europe; stripping blindly would
    // sign it as 32, a 10x error on a price about to be committed.
    const ambiguous = ["3,2", "1,,000", "1,00", "3,20", ",100", "1,000,00"];

    // #when each is normalized
    const out = ambiguous.map(normalizeFlashPrice);

    // #then every one is refused so the caller can ask instead
    expect(out).toEqual(ambiguous.map(() => null));
  });

  it("should refuse anything that is not a positive decimal", () => {
    // #given empty, non-numeric, signed, zero, exponent and trailing-token input
    const bad = ["", "  ", "abc", "3200 NVDA", "-100", "0", "1e5", "3.2.1", "$", "0.002 NVDA"];

    // #when each is normalized
    const out = bad.map(normalizeFlashPrice);

    // #then all are rejected before any wallet prompt
    expect(out).toEqual(bad.map(() => null));
  });
});

describe("isFlashOrderUpdatable", () => {
  it("should not treat PENDING as updatable even though it is cancellable", () => {
    // #given an order still being processed
    const order = orderStub({ status: "ORDER_STATUS_PENDING" });

    // #when updatability is checked
    const updatable = isFlashOrderUpdatable(order);

    // #then it is refused, unlike cancellation — reusing the cancellable set
    // here would surface an edit control that always 422s
    expect({ updatable, cancellable: FLASH_CANCELLABLE_STATUSES.has("ORDER_STATUS_PENDING") })
      .toEqual({ updatable: false, cancellable: true });
  });

  it("should allow the two live statuses", () => {
    // #given the statuses Flash documents as updatable
    const live = ["ORDER_STATUS_ACCEPTED", "ORDER_STATUS_PARTIALLY_FILLED"] as FlashOrderStatus[];

    // #when each is checked
    const out = live.map(status => isFlashOrderUpdatable(orderStub({ status })));

    // #then all are updatable
    expect(out).toEqual([true, true]);
  });

  it("should refuse terminal statuses", () => {
    // #given statuses past the point of repricing
    const terminal = [
      "ORDER_STATUS_FILLED", "ORDER_STATUS_CANCELLED",
      "ORDER_STATUS_REJECTED", "ORDER_STATUS_TERMINATED",
    ] as FlashOrderStatus[];

    // #when each is checked
    const out = terminal.map(status => isFlashOrderUpdatable(orderStub({ status })));

    // #then none are updatable
    expect(out).toEqual(terminal.map(() => false));
  });

  it("should keep the updatable status set narrower than the cancellable one", () => {
    // #given both sets
    // #when PENDING membership is compared
    const inBoth = [...FLASH_UPDATABLE_STATUSES].every(s => FLASH_CANCELLABLE_STATUSES.has(s));

    // #then updatable is a strict subset of cancellable
    expect({ inBoth, sameSize: FLASH_UPDATABLE_STATUSES.size === FLASH_CANCELLABLE_STATUSES.size })
      .toEqual({ inBoth: true, sameSize: false });
  });
});

describe("flashUpdateAxis", () => {
  it("should map a limit order to the limit axis", () => {
    // #given a resting limit order
    // #when its axis is resolved
    const axis = flashUpdateAxis({ orderType: "limit" });

    // #then the repriceable value is its limit price
    expect(axis).toBe("limit");
  });

  it("should map each trigger type to the trigger axis", () => {
    // #given the three trigger order types
    const triggerTypes = ["stop", "stop-loss", "take-profit"] as FlashOrderType[];

    // #when each axis is resolved
    const out = triggerTypes.map(orderType => flashUpdateAxis({ orderType }));

    // #then all reprice their threshold
    expect(out).toEqual(["trigger", "trigger", "trigger"]);
  });

  it("should refuse the order types Flash rejects with 422", () => {
    // #given types with no repriceable axis
    const unsupported = ["twap", "market", "bracket"] as FlashOrderType[];

    // #when each axis is resolved
    const out = unsupported.map(orderType => flashUpdateAxis({ orderType }));

    // #then none offer an update
    expect(out).toEqual(unsupported.map(() => null));
  });
});

describe("triggerPriceOf", () => {
  it("should read a notional trigger with its basis", () => {
    // #given a trigger placed in USD basis
    const trigger = { notionalPrice: "1800", triggerType: "lower" } as const;

    // #when it is read
    const out = triggerPriceOf(trigger);

    // #then price, basis and direction come back together
    expect(out).toEqual({ price: "1800", basis: "notional", triggerType: "lower" });
  });

  it("should read a cross trigger placed through another Flash client", () => {
    // #given a trigger placed in pair-rate basis
    const trigger = { crossPrice: "0.002", triggerType: "upper" } as const;

    // #when it is read
    const out = triggerPriceOf(trigger);

    // #then the cross basis is reported, not silently treated as notional
    expect(out).toEqual({ price: "0.002", basis: "cross", triggerType: "upper" });
  });

  it("should return null for an absent trigger", () => {
    // #given orders with no trigger at all
    // #when each is read
    const out = [triggerPriceOf(null), triggerPriceOf(undefined)];

    // #then nothing is reported
    expect(out).toEqual([null, null]);
  });

  it("should return null for a trigger carrying neither price", () => {
    // #given a malformed trigger
    const trigger = { triggerType: "lower" } as const;

    // #when it is read
    const out = triggerPriceOf(trigger);

    // #then it is treated as unreadable rather than defaulting a basis
    expect(out).toBeNull();
  });
});

describe("limitPriceOf", () => {
  it("should read a notional limit price", () => {
    // #given an order priced in USD
    const order = { limitNotionalPrice: "4000", limitCrossPrice: null };

    // #when the limit is read
    const out = limitPriceOf(order);

    // #then the notional basis is reported
    expect(out).toEqual({ price: "4000", basis: "notional" });
  });

  it("should read a cross limit price", () => {
    // #given an order priced in the pair rate
    const order = { limitNotionalPrice: null, limitCrossPrice: "0.0004" };

    // #when the limit is read
    const out = limitPriceOf(order);

    // #then the cross basis is reported
    expect(out).toEqual({ price: "0.0004", basis: "cross" });
  });

  it("should return null when the order carries no limit price", () => {
    // #given a pure trigger order
    const order = { limitNotionalPrice: null, limitCrossPrice: null };

    // #when the limit is read
    const out = limitPriceOf(order);

    // #then nothing is reported
    expect(out).toBeNull();
  });
});

describe("FLASH_UPDATE_INTENT_RE", () => {
  it("should recognize a request to modify a standing order", () => {
    // #given phrasings that name an existing order and a modification verb
    const asks = [
      "move my stop to $3200",
      "move my stop on ETH to $3200",
      "change my limit order to $4000",
      "update my stop loss to 3200",
      "reprice my limit to 4000",
      "raise my take profit to $6000",
      "lower my stop loss to 2000",
      "adjust my take profit to 7000",
      "edit my order",
      "bump my limit to 4500",
      "modify my stop loss",
      "change the stop loss to 2900",
      // names the chain but no amount — the guided-bridge block above fires
      // on exactly that shape, so this one must reach the reprice block
      "move my stop on robinhood",
    ];

    // #when each is tested
    const out = asks.map(a => FLASH_UPDATE_INTENT_RE.test(a));

    // #then all route to the orders card rather than the placement path
    expect(out).toEqual(asks.map(() => true));
  });

  it("should not swallow a request to place a new order", () => {
    // #given real placements. this block sits directly above the
    // order-PLACEMENT block in the chat route, so a false positive here
    // turns an order into a listing.
    const placements = [
      "sell 2 ETH if it drops below $2000",
      "buy $2000 of ETH at $1800",
      "sell 2 ETH when it hits $5000",
      "buy $500 of ETH over 7 days",
      "set a stop loss at $3000",
      "limit buy ETH at 2800",
      "dca into ETH over a week",
      "buy 0.05 ETH when it drops to $2800",
      "purchase $50 of TSLA on robinhood",
      "sell my NVDA",
    ];

    // #when each is tested
    const out = placements.map(p => FLASH_UPDATE_INTENT_RE.test(p));

    // #then none are intercepted
    expect(out).toEqual(placements.map(() => false));
  });

  it("should not swallow unrelated commands that share its vocabulary", () => {
    // #given other traffic through the same waterfall
    const unrelated = [
      "my orders", "order status", "what is a stop loss", "stop loss explained",
      "eth price", "should i buy eth", "swap 1 eth to usdc on base",
      "bridge 0.1 eth from base to arbitrum", "show my portfolio",
    ];

    // #when each is tested
    const out = unrelated.map(u => FLASH_UPDATE_INTENT_RE.test(u));

    // #then none are intercepted
    expect(out).toEqual(unrelated.map(() => false));
  });
});

describe("buildFlashCancelMessage", () => {
  it("should keep the v1 that the update header omits", () => {
    // #given an order id
    // #when the cancel message is built
    const msg = buildFlashCancelMessage(ORDER_ID);

    // #then it matches Flash's cancel format exactly — the two headers differ
    // by that "v1", and each endpoint validates its own bytes
    expect(msg).toBe(`Definitive Flash v1 — Cancel Order\nOrder: ${ORDER_ID}`);
  });

  it("should not share a header with the update message", () => {
    // #given both messages for the same order
    const cancel = buildFlashCancelMessage(ORDER_ID);
    const update = buildFlashUpdate({ orderId: ORDER_ID, limit: { price: "1", basis: "notional" } })!.updateMessage;

    // #when their headers are compared
    const headers = [cancel.split("\n")[0], update.split("\n")[0]];

    // #then they are distinct — copying one to the other yields a 404
    expect(headers).toEqual([
      "Definitive Flash v1 — Cancel Order",
      "Definitive Flash — Update Order",
    ]);
  });
});

describe("validateFlashUpdateBody", () => {
  const signed = { orderId: ORDER_ID, updateMessage: "msg", userSignature: "0xsig" };

  it("should accept a well-formed trigger update", () => {
    // #given a signed body carrying one trigger price
    const body = { ...signed, trigger: { notionalPrice: "1800", triggerType: "lower" } };

    // #when it is validated
    const issue = validateFlashUpdateBody(body);

    // #then nothing is wrong with it
    expect(issue).toBeNull();
  });

  it("should name every missing required field at once", () => {
    // #given a body with no signature material at all
    const body = { limitNotionalPrice: "4000" };

    // #when it is validated
    const issue = validateFlashUpdateBody(body);

    // #then all three are reported together, not one per round trip
    expect(issue).toEqual({ code: "missing_fields", fields: ["orderId", "updateMessage", "userSignature"] });
  });

  it("should refuse a body with no price to change", () => {
    // #given a signed body carrying neither a limit nor a trigger
    // #when it is validated
    const issue = validateFlashUpdateBody(signed);

    // #then it is refused here rather than 422ing upstream
    expect(issue).toEqual({ code: "no_price" });
  });

  it("should refuse both limit bases at once", () => {
    // #given mutually exclusive limit fields
    const body = { ...signed, limitNotionalPrice: "4000", limitCrossPrice: "0.002" };

    // #when it is validated
    const issue = validateFlashUpdateBody(body);

    // #then the conflict is named rather than passed upstream
    expect(issue).toEqual({ code: "both_limit_bases" });
  });

  it("should refuse both trigger bases at once", () => {
    // #given mutually exclusive trigger fields
    const body = { ...signed, trigger: { notionalPrice: "1800", crossPrice: "0.002" } };

    // #when it is validated
    const issue = validateFlashUpdateBody(body);

    // #then the conflict is named
    expect(issue).toEqual({ code: "both_trigger_bases" });
  });
});

describe("flashUpdateErrorMessage", () => {
  it("should not tell the user a 404 means the order is missing", () => {
    // #given Flash's 404, which also covers a bad signature or one wrong byte
    // #when it is mapped to copy
    const msg = flashUpdateErrorMessage(404);

    // #then both causes are surfaced, since we cannot tell them apart
    expect(msg).toContain("signature");
  });

  it("should explain a 422 as the order having moved on", () => {
    // #given Flash's 422 — terminal, already filled, or update in flight
    // #when it is mapped to copy
    const msg = flashUpdateErrorMessage(422);

    // #then it says the order can no longer be updated
    expect(msg).toContain("can't be updated anymore");
  });

  it("should map an unknown status to a retryable message", () => {
    // #given a status with no specific mapping
    // #when it is mapped to copy
    const msg = flashUpdateErrorMessage(500);

    // #then the user is told to retry rather than shown a bare code
    expect(msg).toContain("try again");
  });
});

describe("validateBracket", () => {
  const notional = (price: string) => ({ price, basis: "notional" as const });

  it("should accept a pair with take-profit above stop-loss", () => {
    // #given a correctly ordered pair in one basis
    const bracket = { takeProfit: notional("5000"), stopLoss: notional("3000") };

    // #when it is validated
    const issue = validateBracket(bracket);

    // #then nothing is wrong with it
    expect(issue).toBeNull();
  });

  it("should reject a transposed pair rather than quoting it", () => {
    // #given the legs the wrong way round — the common user slip
    const bracket = { takeProfit: notional("3000"), stopLoss: notional("5000") };

    // #when it is validated
    const issue = validateBracket(bracket);

    // #then it is named, not sent upstream for an opaque error
    expect(issue).toEqual({ code: "tp_not_above_sl" });
  });

  it("should reject legs that are equal", () => {
    // #given a pair with no gap between the exits
    const bracket = { takeProfit: notional("4000"), stopLoss: notional("4000") };

    // #when it is validated
    const issue = validateBracket(bracket);

    // #then it is refused — flash requires take-profit strictly above
    expect(issue).toEqual({ code: "tp_not_above_sl" });
  });

  it("should reject legs priced in different bases", () => {
    // #given one leg in USD and the other as a pair rate
    const bracket = { takeProfit: notional("5000"), stopLoss: { price: "0.002", basis: "cross" as const } };

    // #when it is validated
    const issue = validateBracket(bracket);

    // #then the mismatch is caught — flash requires one basis for both
    expect(issue).toEqual({ code: "mixed_basis" });
  });

  it("should reject a non-positive price", () => {
    // #given a zero-priced leg
    const bracket = { takeProfit: notional("5000"), stopLoss: notional("0") };

    // #when it is validated
    const issue = validateBracket(bracket);

    // #then it is refused before a wallet ever sees it
    expect(issue).toEqual({ code: "non_positive" });
  });
});

describe("isBracketableOrderType", () => {
  it("should allow the three entry types Flash brackets", () => {
    // #given market, limit and twap entries
    const entries = ["market", "limit", "twap"] as FlashOrderType[];

    // #when each is checked
    const out = entries.map(isBracketableOrderType);

    // #then all can carry a pair
    expect(out).toEqual([true, true, true]);
  });

  it("should refuse to bracket a trigger order, which already is one", () => {
    // #given the trigger types
    const triggers = ["stop", "stop-loss", "take-profit", "bracket"] as FlashOrderType[];

    // #when each is checked
    const out = triggers.map(isBracketableOrderType);

    // #then none can carry a pair
    expect(out).toEqual(triggers.map(() => false));
  });
});
