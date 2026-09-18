import { describe, expect, it } from "vitest";
import {
  compileSeal, validateSealPolicy, validateSize, sanitizeTitle, sizeUnitLabel, impactRejection, sealPublishMessage,
  type SealDraft, type SealPolicy,
} from "@/lib/seal";
import { FLASH_ADVANCED_ORDER_CHAINS } from "@/app/api/chat/route";

// compileSeal is the hinge of the whole product: the quote step and the submit
// step both derive the order from it, so "what the page showed" and "what Flash
// received" are the same function applied to the same stored record. If it can
// drift between those two calls, a stranger's policy can execute as something
// else — which is the one failure this product cannot have.

const SUPPORTED = new Set(Object.keys(FLASH_ADVANCED_ORDER_CHAINS).map(Number));

const base: SealDraft = {
  title:     "NVDA dip buy",
  creator:   "0x1111111111111111111111111111111111111111",
  side:      "buy",
  orderType: "limit",
  token:     "NVDA",
  chain:     "base",
  priceLevel: "200",
  sizing:    { min: "50", max: "5000", suggested: "500" },
};

function policy(over: Partial<SealPolicy> = {}): SealPolicy {
  return { ...base, id: "abc123def456", version: 1, createdAt: 0, ...over } as SealPolicy;
}

describe("compileSeal", () => {
  it("should put the consumer's size in, and nothing else", () => {
    // #given a policy and a size the consumer chose
    // #when it is compiled
    const intent = compileSeal(policy(), "500");

    // #then the result is the creator's policy with exactly one field added
    expect(intent).toEqual({
      side: "buy", orderType: "limit", token: "NVDA", chain: "base",
      qty: "500", priceLevel: "200",
    });
  });

  it("should compile two sizes to two intents that differ only in qty", () => {
    // #given one policy instantiated by two wallets at different sizes
    const p = policy();

    // #when each is compiled
    const a = compileSeal(p, "500");
    const b = compileSeal(p, "200");

    // #then everything except the size is identical — this is what "one policy,
    // many wallets" means at the level of the code
    expect({ ...a, qty: null }).toEqual({ ...b, qty: null });
    expect([a.qty, b.qty]).toEqual(["500", "200"]);
  });

  it("should carry a stop-loss trigger direction through", () => {
    // #given a trigger policy
    const p = policy({ side: "sell", orderType: "stop-loss", triggerType: "lower", priceLevel: "180" });

    // #when compiled
    const intent = compileSeal(p, "2");

    // #then the direction survives — dropping it would promote the order to a
    // different Flash order type
    expect(intent).toMatchObject({ orderType: "stop-loss", triggerType: "lower", qty: "2" });
  });

  it("should carry a TWAP schedule through", () => {
    // #given a TWAP policy with a bucket count
    const p = policy({ orderType: "twap", priceLevel: undefined, durationSeconds: 604800, twapBucketCount: 7 });

    // #when compiled
    const intent = compileSeal(p, "500");

    // #then the schedule is intact and no price was invented
    expect(intent).toMatchObject({ orderType: "twap", durationSeconds: 604800, twapBucketCount: 7 });
    expect(intent.priceLevel).toBeUndefined();
  });

  it("should carry an attached bracket through untouched", () => {
    // #given a protected entry
    const bracket = {
      takeProfit: { price: "240", basis: "notional" as const },
      stopLoss:   { price: "180", basis: "notional" as const },
    };

    // #when compiled
    const intent = compileSeal(policy({ bracket }), "500");

    // #then the pair arrives byte-identical — a dropped bracket would leave a
    // consumer who asked for protection holding an unprotected order
    expect(intent.bracket).toEqual(bracket);
  });

  it("should omit absent optional fields rather than setting them undefined", () => {
    // #given a policy with no trigger, duration or bracket
    // #when compiled
    const intent = compileSeal(policy(), "500");

    // #then those keys are absent — Flash validates the submit body
    // independently of the quote, and an explicit undefined serializes away
    // differently from an absent key
    expect(Object.keys(intent).sort()).toEqual(
      ["chain", "orderType", "priceLevel", "qty", "side", "token"],
    );
  });
});

describe("validateSealPolicy", () => {
  it("should accept a well-formed policy", () => {
    expect(validateSealPolicy(base, SUPPORTED)).toBeNull();
  });

  it.each([
    ["title_missing",        { title: "   " }],
    ["title_too_long",       { title: "x".repeat(61) }],
    ["creator_invalid",      { creator: "not-a-wallet" }],
    ["token_invalid",        { token: "" }],
    ["chain_unknown",        { chain: "narnia" }],
    ["price_required",       { priceLevel: undefined }],
    ["price_invalid",        { priceLevel: "0" }],
    ["sizing_invalid",       { sizing: { min: "0", max: "10", suggested: "5" } }],
    ["sizing_unordered",     { sizing: { min: "100", max: "10", suggested: "5" } }],
  ])("should refuse a policy with %s", (code, over) => {
    // #given a draft with one thing wrong
    const draft = { ...base, ...over } as SealDraft;

    // #when it is validated
    // #then it is refused at publish, not at instantiate — a Seal that cannot
    // compile is a link the creator already shared
    expect(validateSealPolicy(draft, SUPPORTED)?.code).toBe(code);
  });

  it("should refuse an unsupported chain even when the name resolves", () => {
    // #given a real chain Flash does not carry advanced orders on
    const draft = { ...base, chain: "solana" } as SealDraft;

    // #then the failure names the chain rather than the parser
    expect(validateSealPolicy(draft, SUPPORTED)?.code).toBe("chain_unsupported");
  });

  it("should refuse a buy-side trigger order", () => {
    // #given a stop-loss described as a buy
    const draft = { ...base, orderType: "stop-loss" as const, triggerType: "lower" as const };

    // #then it is refused — a trigger order always sells
    expect(validateSealPolicy(draft, SUPPORTED)?.code).toBe("trigger_side");
  });

  it("should refuse a take-profit pointed the wrong way", () => {
    // #given a take-profit that triggers on the way down
    const draft = { ...base, side: "sell" as const, orderType: "take-profit" as const, triggerType: "lower" as const };

    // #then the mismatch is caught here, not by Flash after a wallet connects
    expect(validateSealPolicy(draft, SUPPORTED)?.code).toBe("trigger_type_mismatch");
  });

  it("should refuse a TWAP shorter than Flash accepts", () => {
    const draft = { ...base, orderType: "twap" as const, priceLevel: undefined, durationSeconds: 60 };
    expect(validateSealPolicy(draft, SUPPORTED)?.code).toBe("duration_too_short");
  });

  it("should refuse a transposed bracket", () => {
    // #given a pair whose take-profit sits below its stop-loss — the common slip
    const draft = {
      ...base,
      bracket: {
        takeProfit: { price: "180", basis: "notional" as const },
        stopLoss:   { price: "240", basis: "notional" as const },
      },
    };

    // #then it is refused before it can be published and shared
    expect(validateSealPolicy(draft, SUPPORTED)?.code).toBe("bracket_invalid");
  });

  it("should refuse a bracket on a trigger order", () => {
    // #given a stop-loss carrying its own bracket
    const draft = {
      ...base,
      side: "sell" as const, orderType: "stop-loss" as const, triggerType: "lower" as const,
      bracket: {
        takeProfit: { price: "240", basis: "notional" as const },
        stopLoss:   { price: "180", basis: "notional" as const },
      },
    };

    // #then it is refused — a trigger order already is a trigger
    expect(validateSealPolicy(draft, SUPPORTED)?.code).toBe("bracket_not_allowed");
  });

  it("should strip control characters from a creator-supplied title", () => {
    // #given a title with embedded control characters, which renders to strangers
    // #when it is sanitized
    // #then it collapses to plain text
    // Built from code points, not pasted: literal control bytes in a source
    // file are invisible in every diff and editor that will ever show this.
    const nasty = `NVDA${String.fromCharCode(0)}${String.fromCharCode(31)}  dip\nbuy `;
    expect(sanitizeTitle(nasty)).toBe("NVDA dip buy");
  });
});

describe("validateSize", () => {
  it.each([
    ["size_invalid",   "nonsense"],
    ["size_invalid",   "0"],
    ["size_invalid",   "-5"],
    ["size_below_min", "10"],
    ["size_above_max", "99999"],
  ])("should refuse %s", (code, size) => {
    expect(validateSize(policy(), size)?.code).toBe(code);
  });

  it("should accept the bounds themselves", () => {
    // #given sizes exactly on the creator's limits
    // #then both are allowed — bounds are inclusive, and an off-by-one here
    // reads to a consumer as the page rejecting its own suggestion
    expect([validateSize(policy(), "50"), validateSize(policy(), "5000")]).toEqual([null, null]);
  });
});

describe("sizeUnitLabel", () => {
  it("should name the contra asset on a buy and the token on a sell", () => {
    // #given Flash's rule that qty is the asset being SPENT
    // #then the label flips with the side — rendering the number bare is the
    // bug this exists to prevent
    expect({
      buy:  sizeUnitLabel(policy(), "USDC"),
      sell: sizeUnitLabel(policy({ side: "sell" }), "USDC"),
    }).toEqual({ buy: "USDC", sell: "NVDA" });
  });
});

describe("impact cap", () => {
  it("should carry the creator's cap into the compiled intent", () => {
    // #given a Seal with a cap
    // #when compiled
    const intent = compileSeal(policy({ maxImpact: "0.05" }), "5");

    // #then it reaches Flash as the request's maxPriceImpact
    expect(intent.maxImpact).toBe("0.05");
  });

  it("should refuse a quote whose impact exceeded the cap", () => {
    // #given Flash returned a worse impact than the request asked for — its
    // spec says explicitly that this can happen
    const issue = impactRejection("0.081", "0.05");

    // #then the take is refused, and the message names both numbers so the
    // consumer knows to go smaller rather than just that it failed
    expect(issue?.code).toBe("impact_too_high");
    expect(issue?.message).toContain("8.10%");
    expect(issue?.message).toContain("5.00%");
  });

  it("should allow an impact exactly at the cap", () => {
    expect(impactRejection("0.05", "0.05")).toBeNull();
  });

  it("should not refuse when the Seal set no cap", () => {
    // #given a policy with no cap, which is the pre-existing shape
    // #then nothing is enforced — absence is not a zero
    expect(impactRejection("0.9", undefined)).toBeNull();
  });

  it("should not refuse when Flash produced no estimate", () => {
    // #given a null estimate, which Flash's schema allows
    // #then we do not invent a rejection from a missing number
    expect(impactRejection(null, "0.05")).toBeNull();
  });

  it.each(["5", "0", "-0.1", "abc", "1.5"])("should refuse %j as a cap at publish", (bad) => {
    // #given a cap that isn't a decimal fraction — "5" reads as 500% and caps
    // nothing, which is worse than no cap because the page would claim one
    expect(validateSealPolicy({ ...base, maxImpact: bad }, SUPPORTED)?.code).toBe("impact_invalid");
  });

  it("should attest the cap in the signature the creator gives", () => {
    // #given a Seal with a cap
    const withCap = sealPublishMessage({ ...base, maxImpact: "0.05" });

    // #then the cap is in the signed bytes. a field absent from the message is
    // a field someone else could have set
    expect(withCap).toContain("Max impact: 0.05");
  });
});

describe("percentage protection", () => {
  const pct = policy({ priceLevel: "2400", slPct: "0.08", tpPct: "0.20" });

  it("should compile percentages into absolute triggers at the entry", () => {
    // #given 8% down and 20% up on a $2,400 entry
    // #when the Seal is compiled
    const intent = compileSeal(pct, "5");

    // #then Flash gets prices, never percentages — it has no concept of one
    expect(intent.bracket).toEqual({
      stopLoss:   { price: "2208", basis: "notional" },
      takeProfit: { price: "2880", basis: "notional" },
    });
  });

  it("should give two takes of one Seal identical protection", () => {
    // #given two wallets taking the same policy at different sizes
    const a = compileSeal(pct, "5");
    const b = compileSeal(pct, "10");

    // #then the protection is the same shape AND the same prices, because it
    // is measured from the entry the policy names rather than from whatever
    // the market happened to be doing when each of them clicked
    expect(a.bracket).toEqual(b.bracket);
    expect([a.qty, b.qty]).toEqual(["5", "10"]);
  });

  it("should measure a market entry against the mark instead", () => {
    // #given a market policy, which has no entry price of its own
    const market = policy({ orderType: "limit", priceLevel: undefined, slPct: "0.10", tpPct: "0.10" });

    // #when a mark is supplied at take time
    const intent = compileSeal(market, "5", 2000);

    // #then the levels come off the mark
    expect(intent.bracket).toEqual({
      stopLoss:   { price: "1800", basis: "notional" },
      takeProfit: { price: "2200", basis: "notional" },
    });
  });

  it("should leave an order unprotected rather than invent a base price", () => {
    // #given percentages with no entry and no mark
    const market = policy({ priceLevel: undefined, slPct: "0.10", tpPct: "0.10" });

    // #then no bracket is produced. guessing a base would put a real stop at a
    // made-up price, which is worse than no stop because the page claims one
    expect(compileSeal(market, "5").bracket).toBeUndefined();
  });

  it("should keep an explicit bracket untouched", () => {
    // #given a Seal that names absolute prices
    const abs = policy({
      bracket: {
        takeProfit: { price: "3200", basis: "notional" },
        stopLoss:   { price: "2000", basis: "notional" },
      },
    });

    // #then percentages never override what the creator wrote
    expect(compileSeal(abs, "5").bracket).toEqual(abs.bracket);
  });

  it.each([
    ["protection_conflict", { slPct: "0.08", tpPct: "0.2", bracket: { takeProfit: { price: "3000", basis: "notional" as const }, stopLoss: { price: "2000", basis: "notional" as const } } }],
    ["pct_incomplete",      { slPct: "0.08" }],
    ["pct_invalid",         { slPct: "8", tpPct: "20" }],
    ["pct_invalid",         { slPct: "0", tpPct: "0.2" }],
  ])("should refuse %s at publish", (code, over) => {
    // #given percentages a creator could plausibly get wrong — "8" reads as
    // 700% below the entry, a negative price, after they believed they set 8%
    expect(validateSealPolicy({ ...base, ...over } as SealDraft, SUPPORTED)?.code).toBe(code);
  });

  it("should attest the percentages in the publish signature", () => {
    expect(sealPublishMessage({ ...base, slPct: "0.08", tpPct: "0.20" }))
      .toContain("Protection: stop -0.08, target +0.20");
  });
});
