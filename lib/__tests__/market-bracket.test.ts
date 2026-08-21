import { describe, expect, it } from "vitest";
import { extractBracket } from "@/lib/flashBracket";
import { normalizeFlashPrice } from "@/lib/flashUpdate";
import { parseMarketEntry } from "@/app/api/chat/route";

// Flash's bracket docs lead with a MARKET entry carrying take-profit and
// stop-loss, and that is the phrasing users reach for first — no entry price,
// just "buy this and protect it". The first pass scoped market out, so the
// documented headline case was the one that did not work.

const parse = (msg: string) => {
  const bracket = extractBracket(msg, normalizeFlashPrice);
  return bracket ? { bracket: bracket.bracket, entry: parseMarketEntry(bracket.remainder) } : null;
};

describe("market entry with an attached bracket", () => {
  it("should parse a dollar-denominated protected buy", () => {
    // #given the shape from Flash's own bracket documentation
    const out = parse("buy $500 of ETH, stop $3000, target $5000");

    // #when entry and pair are read
    // #then both resolve, with the entry as a market order
    expect({ side: out?.entry?.side, orderType: out?.entry?.orderType, qty: out?.entry?.qty, token: out?.entry?.token })
      .toEqual({ side: "buy", orderType: "market", qty: "500", token: "ETH" });
  });

  it("should carry the pair alongside the market entry", () => {
    // #given the same message
    const out = parse("buy $500 of ETH, stop $3000, target $5000");

    // #then the legs survive the entry parse
    expect([out?.bracket.takeProfit.price, out?.bracket.stopLoss.price]).toEqual(["5000", "3000"]);
  });

  it("should keep an explicit chain suffix", () => {
    // #given an entry naming its chain
    const out = parse("buy $500 of ETH on base, stop $3000, target $5000");

    // #then the chain reaches the resolver rather than defaulting
    expect(out?.entry?.chain).toBe("base");
  });

  it("should parse a token-denominated buy", () => {
    // #given a quantity rather than a dollar spend
    const out = parse("buy 0.5 ETH, stop $3000, target $5000");

    // #then the amount is read as tokens
    expect(out?.entry?.qty).toBe("0.5");
  });

  it("should parse a protected sell", () => {
    // #given a sell entry
    const out = parse("sell 2 ETH, stop $3000, target $5000");

    // #then the side is carried through
    expect({ side: out?.entry?.side, qty: out?.entry?.qty }).toEqual({ side: "sell", qty: "2" });
  });

  it("should parse a protected stock buy on Robinhood Chain", () => {
    // #given the stock shape that previously dropped its pair silently
    const out = parse("buy $1000 of TSLA on robinhood, stop $200, target $300");

    // #then entry and pair both survive
    expect({ token: out?.entry?.token, chain: out?.entry?.chain, stop: out?.bracket.stopLoss.price })
      .toEqual({ token: "TSLA", chain: "robinhood", stop: "200" });
  });
});

describe("parseMarketEntry boundaries", () => {
  it("should not claim an order that states a price", () => {
    // #given a limit entry — the existing parsers own this
    // #when read as a market entry
    const out = parseMarketEntry("buy $500 of ETH at $2800");

    // #then it is declined
    expect(out).toBeNull();
  });

  it("should not claim a scheduled order", () => {
    // #given a TWAP entry
    const out = parseMarketEntry("buy $500 of ETH over 7 days");

    // #then it is declined
    expect(out).toBeNull();
  });

  it("should not claim a swap", () => {
    // #given swap phrasing, which belongs to the Delora pipeline
    const out = parseMarketEntry("swap 1 eth to usdc on base");

    // #then it is declined
    expect(out).toBeNull();
  });
});
