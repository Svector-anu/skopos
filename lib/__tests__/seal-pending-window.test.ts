import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// A take parks its order at quote time and has until the record expires to come
// back with signatures. At 180s that window failed the first real two-wallet
// run: a first-time taker approves two tokens before signing anything, and the
// take came back "expired" on an order Flash would have accepted — both of its
// signatures carry the non-expiring deadline sentinel.
//
// The longer window is only safe because no Seal is a market order. Flash uses
// quoteId solely to fix a market order's price; every other order type takes
// its price from the policy. So the publish schema is pinned here too: letting
// "market" in would make a long-parked quote re-price at submit.

const ttls = new Map<string, number | undefined>();

vi.mock("@/lib/redis", () => ({
  getRedis: () => ({
    get: async () => null,
    set: async (key: string, _value: string, opts?: { ex?: number; nx?: boolean }) => {
      ttls.set(key, opts?.ex);
      return "OK";
    },
    del: async () => 1,
    incr: async () => 1,
  }),
}));

const { putPendingOrder } = await import("@/lib/sealStore");
const { POST: publish } = await import("@/app/api/seal/route");

async function parkedFor(quoteId: string): Promise<number | undefined> {
  await putPendingOrder(quoteId, {
    sealId: "abc123abc123",
    size: "5",
    funderAddress: "0xfunder",
    submit: {
      targetChain: "base", contraChain: "base",
      targetAsset: "0xtarget", contraAsset: "0xcontra",
      side: "buy", qty: "5", orderType: "limit",
      funderAddress: "0xfunder", quoteId,
      evmOrderTypedData: "{}",
      limitCrossPrice: "2400",
    },
    bracket: null,
  });
  return ttls.get(`seal:pending:${quoteId}`);
}

function publishRequest(orderType: string) {
  return new NextRequest("https://www.tryskopos.xyz/api/seal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "eth dip",
      creator: "0x1111111111111111111111111111111111111111",
      signature: `0x${"ab".repeat(65)}`,
      side: "buy", orderType, token: "ETH", chain: "base",
      priceLevel: "2400",
      sizing: { min: "1", max: "20", suggested: "5" },
    }),
  });
}

describe("seal pending window", () => {
  it("should keep a take's order parked through a first-time taker's approvals", async () => {
    // #given a quote parked for submit
    const ttl = await parkedFor("q-approvals");

    // #then it outlives two approvals and two signatures. 180s did not
    expect(ttl).toBeGreaterThanOrEqual(10 * 60);
  });

  it("should still let an abandoned quote expire", async () => {
    // #given a quote nobody comes back for
    const ttl = await parkedFor("q-abandoned");

    // #then it ages out on its own — staleness keeps failing closed, and
    // records from looks that never became takes do not pile up
    expect(ttl).toBeLessThanOrEqual(60 * 60);
  });

  it("should refuse to publish a market Seal", async () => {
    // #given a policy asking for a market entry
    const res = await publish(publishRequest("market"));

    // #then the schema rejects it. a market order re-prices at submit, and the
    // window above is only safe for orders whose price the policy fixes
    expect(res.status).toBe(400);
  });

  it("should get a priced Seal past the schema with the same body", async () => {
    // #given the identical body with a limit entry
    const res = await publish(publishRequest("limit"));

    // #then the schema lets it through, so the rejection above is the order
    // type and not some other field. it fails later, on the dummy signature
    expect(res.status).not.toBe(400);
  });
});
