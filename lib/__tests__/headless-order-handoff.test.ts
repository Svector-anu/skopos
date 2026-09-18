import { describe, expect, it } from "vitest";
import { cardToText, executeLinkFor, headlessHandoffFields } from "@/lib/cardToText";
import { POST } from "@/app/api/chat/route";
import { NextRequest } from "next/server";

async function ask(message: string) {
  const request = new NextRequest("https://www.tryskopos.xyz/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `test-${message}` },
    body: JSON.stringify({ message, format: "text" }),
  });
  return POST(request).then((response) => response.json());
}

describe("advanced-order headless handoff", () => {
  const handoff = {
    type: "quote",
    mode: "handoff",
    orderType: "limit",
    side: "buy",
    qty: "2000",
    price: "1800",
    token: "ETH",
    chain: "base",
  };

  // Flash prices every order in the asset being SPENT, so a buy's qty is a
  // dollar amount and a sell's is a token count. This surface used to print it
  // bare, which turned a $2,000 order into "buy 2000 ETH" — off by the price of
  // ETH, and the only description of the order a headless caller ever sees.
  it("should price a buy in the dollars it spends, not in tokens", async () => {
    // #given a limit buy, whose qty is a dollar spend
    // #when it is rendered for a headless caller
    const text = await cardToText(handoff);

    // #then the amount reads as money
    expect(text).toBe(
      "limit order ready: buy $2000 of ETH at $1800 on base. Tap to review and sign in the Skopos app.",
    );
  });

  it("should price a sell in the tokens it sells", async () => {
    // #given a stop-loss sell, whose qty is a token count
    // #when it is rendered
    const text = await cardToText({
      type: "quote", mode: "handoff", orderType: "stop-loss",
      side: "sell", qty: "2", price: "2000", token: "ETH",
    });

    // #then the amount keeps token units — a dollar sign here would be the
    // same bug in the other direction — and a trigger reads as a trigger, not
    // as a limit price the order does not have
    expect(text).toBe(
      "stop-loss order ready: sell 2 ETH if it drops below $2000. Tap to review and sign in the Skopos app.",
    );
  });

  it("should read a take-profit as a level it rises to", () => {
    // #given a take-profit, which fires on the way up
    // #when it is rendered
    const text = cardToText({
      type: "quote", mode: "handoff", orderType: "take-profit",
      side: "sell", qty: "2", price: "5000", token: "ETH",
    });

    // #then the direction is in the sentence. "at $5000" on a take-profit and
    // "at $2000" on a stop-loss are indistinguishable, and they are opposite
    // orders
    return expect(text).resolves.toBe(
      "take-profit order ready: sell 2 ETH when it hits $5000. Tap to review and sign in the Skopos app.",
    );
  });

  it("should still say \"at\" for a limit order, which does have a price", () => {
    return expect(cardToText({
      type: "quote", mode: "handoff", orderType: "limit",
      side: "sell", qty: "2", price: "3000", token: "ETH",
    })).resolves.toBe(
      "limit order ready: sell 2 ETH at $3000. Tap to review and sign in the Skopos app.",
    );
  });

  it("creates the same app deep-link as other execution handoffs", () => {
    expect(executeLinkFor(handoff, "buy $2000 of ETH at $1800 on base")).toBe(
      "https://www.tryskopos.xyz/app?q=buy%20%242000%20of%20ETH%20at%20%241800%20on%20base",
    );
  });

  it("allowlists intent metadata and drops every signing field", () => {
    expect(headlessHandoffFields({
      ...handoff,
      orderTypedData: "must-not-leak",
      calldata: { to: "0xdead" },
      approval: { data: "0xbeef" },
    })).toEqual({
      mode: "handoff",
      orderType: "limit",
      side: "buy",
      qty: "2000",
      price: "1800",
      token: "ETH",
      chain: "base",
    });
  });

  it("preserves a TWAP duration without inventing a price", () => {
    expect(headlessHandoffFields({
      type: "quote", mode: "handoff", orderType: "twap", side: "sell",
      qty: "2", duration: 604800, token: "ETH",
    })).toEqual({
      mode: "handoff", orderType: "twap", side: "sell", qty: "2",
      duration: 604800, token: "ETH",
    });
  });

  it.each([
    ["buy $2000 of ETH at $1800 on base", { orderType: "limit", side: "buy", qty: "2000", price: "1800", token: "ETH", chain: "base" }],
    ["sell 2 ETH if it drops below $2000", { orderType: "stop-loss", side: "sell", qty: "2", price: "2000", token: "ETH" }],
    ["sell 2 ETH when it hits $5000", { orderType: "take-profit", side: "sell", qty: "2", price: "5000", token: "ETH" }],
    ["buy $500 of ETH over 7 days", { orderType: "twap", side: "buy", qty: "500", duration: 604800, token: "ETH" }],
  ])("returns an inert handoff for %s", async (message, expected) => {
    const response = await ask(message);

    expect(response).toMatchObject({ type: "quote", mode: "handoff", ...expected });
    expect(response.link).toContain("https://www.tryskopos.xyz/app?q=");
    expect(response.text).toContain("order ready");
    expect(response).not.toHaveProperty("orderTypedData");
    expect(response).not.toHaveProperty("calldata");
    expect(response).not.toHaveProperty("approval");
  });
});
