import { describe, expect, it } from "vitest";
import { parseMarketEntry } from "@/app/api/chat/route";
import { RH_STOCK_TOKENS } from "@/lib/flash";

// "buy $50 of NVDA" used to return NVDA's price. Not an error — a different
// question. Every ticker in RH_STOCK_TOKENS is a token classifyIntent reads as
// a price query, so the price fast-path answered before any execution parsing
// ran, and the order only worked if the user wrote "on robinhood".
//
// The routing itself needs a live Flash quote, so what is pinned here is the
// gate: which phrasings claim the market path, and — more importantly — which
// must NOT, because claiming a priced or triggered order here would turn a
// limit order into a market order at whatever the book says.

const isStock = (t: string) => t.toUpperCase() in RH_STOCK_TOKENS;

describe("market stock entry", () => {
  it.each([
    ["buy $50 of NVDA", "buy", "50", "NVDA"],
    ["buy 50 dollars of nvda".replace("50 dollars of", "$50 of"), "buy", "50", "nvda"],
    ["buy $2000 of AAPL", "buy", "2000", "AAPL"],
    ["sell 2 TSLA", "sell", "2", "TSLA"],
    ["buy $50 of NVDA on robinhood", "buy", "50", "NVDA"],
  ])("should claim %j", (msg, side, qty, token) => {
    // #given a bare market order naming a tokenized stock
    const parsed = parseMarketEntry(msg);

    // #then it parses, and the ticker is one we can route
    expect(parsed).toMatchObject({ side, qty, orderType: "market" });
    expect(parsed!.token.toUpperCase()).toBe(token.toUpperCase());
    expect(isStock(parsed!.token)).toBe(true);
  });

  it.each([
    "buy $50 of NVDA at $200",
    "sell 2 NVDA if it drops below $200",
    "sell 2 NVDA when it hits $300",
    "buy $50 of NVDA over 2 days",
  ])("should leave %j to the advanced-order path", (msg) => {
    // #given a priced or scheduled order
    // #then the market parser does not claim it. claiming it would silently
    // turn a limit order into a market one at whatever the book says — the
    // user named a price precisely so it would not execute at the current one
    expect(parseMarketEntry(msg)).toBeNull();
  });

  it("should not send a crypto market buy down the stock path", () => {
    // #given a market buy of something that is not a tokenized stock
    const parsed = parseMarketEntry("buy $50 of ETH");

    // #then it parses, but the ticker gate refuses it — ETH trades on 25
    // chains and defaulting it to Robinhood Chain would be wrong on all of them
    expect(parsed).not.toBeNull();
    expect(isStock(parsed!.token)).toBe(false);
  });

  it("should keep every routable ticker actually routable", () => {
    // #given the registry the gate consults
    const tickers = Object.keys(RH_STOCK_TOKENS);

    // #then each one parses out of a plain market buy. a ticker in the registry
    // that the parser cannot read is a stock we claim to support and cannot buy
    const unparsable = tickers.filter(t => {
      const parsed = parseMarketEntry(`buy $50 of ${t}`);
      return !parsed || parsed.token.toUpperCase() !== t;
    });
    expect(unparsable).toEqual([]);
  });
});
