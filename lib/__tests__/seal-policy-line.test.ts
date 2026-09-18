import { describe, expect, it } from "vitest";
import { sealPolicyLine, contraSymbolForChain, type SealPolicy } from "@/lib/seal";
import { RH_CHAIN_STABLECOIN } from "@/lib/flash";

// The policy sentence renders in two places a stranger reads before signing:
// the Seal page and the share card that travels on X. One function feeds both,
// because a card that says one thing and a page that says another is worse than
// having no card at all.

const base: SealPolicy = {
  id: "abc123def456", version: 1, createdAt: 0,
  title: "dip buy", creator: "0x1111111111111111111111111111111111111111",
  side: "buy", orderType: "limit", token: "ETH", chain: "base",
  priceLevel: "2400", sizing: { min: "1", max: "20", suggested: "5" },
};

const seal = (over: Partial<SealPolicy> = {}): SealPolicy => ({ ...base, ...over });

describe("contraSymbolForChain", () => {
  it("should not drift from the constant it was copied out of", () => {
    // #given lib/seal.ts duplicates RH_CHAIN_STABLECOIN rather than importing
    // it, because importing lib/flash would pull @upstash/redis into the client
    // bundle through the size panel
    // #then the copy still equals the original. this test is the only thing
    // stopping the two from diverging
    expect(contraSymbolForChain("robinhood")).toBe(RH_CHAIN_STABLECOIN);
  });

  it.each([
    ["base", "USDC"],
    ["arbitrum", "USDC"],
    ["arc", "USDC"],
    ["robinhood", "USDG"],
  ])("should quote %s in %s", (chain, expected) => {
    expect(contraSymbolForChain(chain)).toBe(expected);
  });
});

describe("sealPolicyLine", () => {
  it("should name the money a buyer spends, not the token", () => {
    // #given a buy, whose size is denominated in the contra asset
    const line = sealPolicyLine(seal(), "USDC");

    // #then it says USDC. saying ETH here is the unit confusion that already
    // shipped once on the headless surface
    expect(line).toBe("buy ETH at $2400 on base — sized by you, in USDC.");
  });

  it("should name the token a seller sells", () => {
    // #given a sell, whose size is denominated in the token
    const line = sealPolicyLine(seal({ side: "sell", orderType: "take-profit", priceLevel: "3000", triggerType: "upper" }), "USDC");

    // #then the unit flips with the side
    expect(line).toBe("sell ETH when it hits $3000 on base — sized by you, in ETH.");
  });

  it("should read a stop-loss as a drop, not a target", () => {
    const line = sealPolicyLine(seal({ side: "sell", orderType: "stop-loss", priceLevel: "1800", triggerType: "lower" }), "USDC");
    expect(line).toContain("sell ETH if it drops below $1800");
  });

  it("should state a TWAP's span in hours", () => {
    const line = sealPolicyLine(seal({ orderType: "twap", priceLevel: undefined, durationSeconds: 604800 }), "USDC");
    expect(line).toContain("evenly over 168h");
  });

  it("should say out loud that a bracketed policy is protected", () => {
    // #given a policy carrying a stop and a target
    const line = sealPolicyLine(seal({
      bracket: {
        takeProfit: { price: "3200", basis: "notional" },
        stopLoss:   { price: "2000", basis: "notional" },
      },
    }), "USDC");

    // #then both levels appear. a consumer choosing between two Seals cannot
    // see the protection unless the sentence carries it
    expect(line).toContain("protected by a stop at $2000 and a target at $3200");
  });

  it("should use the chain's own stablecoin on Robinhood Chain", () => {
    const line = sealPolicyLine(seal({ chain: "robinhood", token: "NVDA" }), contraSymbolForChain("robinhood"));
    expect(line).toContain("in USDG.");
  });
});
