import { describe, expect, it } from "vitest";
import { fxPriceFor, toUSDRate, PYTH_FEEDS, type PythFeedKey, type PythPrice } from "@/lib/pyth";

// Pyth put FX/metals/equities behind commercial entitlements in 2026-09, so
// these feeds now come from keyless public sources. The replacement quotes FX
// as units-per-USD, while the feed keys encode a direction — so every FX key
// needs an inversion decision, and getting one backwards is silent: a
// plausible number, wrong by the square of the rate.

// Units per 1 USD, the shape open.er-api.com returns.
const PER_USD = { EUR: 0.86671, GBP: 0.742032, AUD: 1.5285, JPY: 155.07604, CHF: 0.7936 };

describe("fxPriceFor", () => {
  it("should invert an X/USD key to give USD per X", () => {
    // #given EUR quoted as 0.86671 EUR per USD
    // #when the EUR/USD feed price is derived
    const price = fxPriceFor("EUR/USD", PER_USD);

    // #then it reads as USD per EUR — above 1, not below
    expect(price).toBeCloseTo(1 / 0.86671, 10);
  });

  it("should pass a USD/X key through unchanged", () => {
    // #given JPY quoted as 155.07604 JPY per USD
    // #when the USD/JPY feed price is derived
    const price = fxPriceFor("USD/JPY", PER_USD);

    // #then it is already the direction the key asks for
    expect(price).toBe(155.07604);
  });

  it("should put every FX key on the correct side of 1", () => {
    // #given the two directions present in the feed set
    // #when each is derived
    const out = {
      eur: fxPriceFor("EUR/USD", PER_USD)!,
      gbp: fxPriceFor("GBP/USD", PER_USD)!,
      aud: fxPriceFor("AUD/USD", PER_USD)!,
      jpy: fxPriceFor("USD/JPY", PER_USD)!,
      chf: fxPriceFor("USD/CHF", PER_USD)!,
    };

    // #then EUR and GBP are worth more than a dollar, AUD less, and the
    // USD/X pairs are quoted in the foreign unit — an inversion bug flips
    // at least one of these
    expect({
      eurAbove1: out.eur > 1,
      gbpAbove1: out.gbp > 1,
      audBelow1: out.aud < 1,
      jpyMany: out.jpy > 100,
      chfBelow1: out.chf < 1,
    }).toEqual({ eurAbove1: true, gbpAbove1: true, audBelow1: true, jpyMany: true, chfBelow1: true });
  });

  it("should round-trip against toUSDRate", () => {
    // #given both FX directions turned into feed prices
    const rate = (k: PythFeedKey): PythPrice =>
      ({ price: fxPriceFor(k, PER_USD)!, publishTime: 0, stale: false });
    const rates = { "EUR/USD": rate("EUR/USD"), "USD/JPY": rate("USD/JPY") };

    // #when the consumer asks for USD-per-unit
    // #then the direct and inverted paths both come back as dollars per unit
    expect({
      eur: Number(toUSDRate("EUR", rates).toFixed(4)),
      jpy: Number(toUSDRate("JPY", rates).toFixed(6)),
    }).toEqual({ eur: 1.1538, jpy: 0.006448 });
  });

  it("should return null for a currency the source omitted", () => {
    // #given a rates table missing the pair
    // #when a price is derived
    const price = fxPriceFor("EUR/USD", { GBP: 0.74 });

    // #then nothing is invented — a missing feed must be absent, not zero
    expect(price).toBeNull();
  });

  it("should return null rather than divide by a zero rate", () => {
    // #given a source returning a nonsense zero
    // #when a price is derived
    const price = fxPriceFor("EUR/USD", { EUR: 0 });

    // #then it refuses instead of yielding Infinity
    expect(price).toBeNull();
  });
});

describe("PYTH_FEEDS routing", () => {
  it("should classify every feed into exactly one supported source", () => {
    // #given the full feed set
    const classes = new Set(Object.values(PYTH_FEEDS));

    // #then only the three implemented sources appear
    expect([...classes].sort()).toEqual(["equity", "fx", "metal"]);
  });

  it("should keep the feed set consumers depend on", () => {
    // #given lib/stockPaired.ts does `symbol in PYTH_FEEDS` as a capability
    // check, and the chat route reads FX and metal keys by name
    const keys = Object.keys(PYTH_FEEDS);

    // #then the classes each still carry their expected members
    expect({
      total: keys.length,
      fx: keys.filter(k => PYTH_FEEDS[k as PythFeedKey] === "fx").length,
      metal: keys.filter(k => PYTH_FEEDS[k as PythFeedKey] === "metal").length,
      hasNvda: "NVDA" in PYTH_FEEDS,
      hasGold: "XAU/USD" in PYTH_FEEDS,
    }).toEqual({ total: 36, fx: 5, metal: 2, hasNvda: true, hasGold: true });
  });

  it("should give every FX key a derivable direction", () => {
    // #given every fx-classified key
    const fxKeys = (Object.keys(PYTH_FEEDS) as PythFeedKey[]).filter(k => PYTH_FEEDS[k] === "fx");

    // #when each is derived from a full rates table
    const undeliverable = fxKeys.filter(k => fxPriceFor(k, PER_USD) === null);

    // #then none are left unresolvable — a key the source cannot answer would
    // silently vanish from the result
    expect(undeliverable).toEqual([]);
  });
});
