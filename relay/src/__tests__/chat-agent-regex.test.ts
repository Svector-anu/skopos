import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { detectQueryType } from "../chat-agent.js";

describe("detectQueryType — price detection", () => {
  test("price of ETH", () => {
    const r = detectQueryType("@skopos-bridge price of ETH");
    assert.deepEqual(r, { queryType: "price", params: { symbol: "ETH" } });
  });

  test("price of BTC (uppercase input)", () => {
    const r = detectQueryType("what's the price of BTC?");
    assert.deepEqual(r, { queryType: "price", params: { symbol: "BTC" } });
  });

  test("ETH price (token first)", () => {
    const r = detectQueryType("what is the ETH price");
    assert.deepEqual(r, { queryType: "price", params: { symbol: "ETH" } });
  });

  test("how much is SOL", () => {
    const r = detectQueryType("how much is SOL worth right now");
    assert.deepEqual(r, { queryType: "price", params: { symbol: "SOL" } });
  });

  test("does NOT match 'the price' — PRICE_SKIP guard", () => {
    const r = detectQueryType("@skopos-bridge what is the price");
    // 'the' is in PRICE_SKIP so the match is rejected
    assert.equal(r, null);
  });

  test("does NOT match 'a price' — PRICE_SKIP guard", () => {
    const r = detectQueryType("give me a price");
    assert.equal(r, null);
  });

  test("returns null for unrecognised query", () => {
    const r = detectQueryType("@skopos-bridge hello how are you");
    assert.equal(r, null);
  });
});

describe("detectQueryType — yield detection", () => {
  test("yield keyword defaults to USDC", () => {
    const r = detectQueryType("what are the best yields right now");
    assert.deepEqual(r, { queryType: "yield", params: { symbol: "USDC", limit: 5 } });
  });

  test("yield with explicit token", () => {
    const r = detectQueryType("what are the best ETH yields in DeFi");
    assert.deepEqual(r, { queryType: "yield", params: { symbol: "ETH", limit: 5 } });
  });

  test("APY keyword triggers yield", () => {
    const r = detectQueryType("@skopos-bridge what USDC APY is available on Aave");
    assert.deepEqual(r, { queryType: "yield", params: { symbol: "USDC", limit: 5 } });
  });

  test("lending keyword triggers yield", () => {
    const r = detectQueryType("best lending rates for DAI");
    assert.deepEqual(r, { queryType: "yield", params: { symbol: "DAI", limit: 5 } });
  });
});

describe("detectQueryType — markets detection", () => {
  test("odds keyword triggers markets", () => {
    const r = detectQueryType("@skopos-bridge what are the odds of Bitcoin hitting 100k");
    assert.ok(r !== null);
    assert.equal(r.queryType, "markets");
  });

  test("probability keyword triggers markets", () => {
    const r = detectQueryType("what is the probability of ETH flipping BTC");
    assert.ok(r !== null);
    assert.equal(r.queryType, "markets");
  });
});

describe("detectQueryType — priority: price wins over yield", () => {
  test("'price of ETH' beats yield keywords if both present", () => {
    const r = detectQueryType("what is the price of ETH yield");
    // price pattern matches first; yield match never fires
    assert.deepEqual(r, { queryType: "price", params: { symbol: "ETH" } });
  });
});
