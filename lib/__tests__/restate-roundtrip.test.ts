import { describe, expect, it } from "vitest";
import { extractBracket } from "@/lib/flashBracket";
import { normalizeFlashPrice } from "@/lib/flashUpdate";
import { parseFlashOrderIntent, restate, parseMarketEntry } from "@/app/api/chat/route";

// restate() is quoted in every "which chain?" prompt, so whatever it emits is
// what the user sends back. It has to round-trip: re-parsing its output must
// produce the same order, with its bracket intact.
//
// Both halves failed before. "buy $20 of ETH at $2300" restated as "buy 20 ETH
// at $2300", which matches NO pattern — the user follows our own suggestion
// and gets an ask instead of a quote — and any attached bracket was dropped,
// silently turning a protected order into an unprotected one.

/** Parses a message the way the chat route does: bracket first, then entry. */
function parseFull(message: string) {
  const bracket = extractBracket(message, normalizeFlashPrice);
  const text = bracket?.remainder ?? message;
  const parsed = parseFlashOrderIntent(text);
  let order = parsed && "order" in parsed ? parsed.order : null;
  if (!order && bracket) order = parseMarketEntry(text);
  if (order && bracket) order.bracket = bracket.bracket;
  return order;
}

describe("restate round-trip", () => {
  it("should re-parse a limit buy to the same size", () => {
    // #given a dollar-denominated limit buy
    const original = parseFull("buy $20 of ETH at $2300")!;

    // #when it is restated and parsed again
    const again = parseFull(restate(original));

    // #then the spend survives — "buy 20 ETH" would be a different order
    // entirely, and in fact parses as nothing at all
    expect({ qty: again?.qty, price: again?.priceLevel }).toEqual({ qty: "20", price: "2300" });
  });

  it("should produce a suggestion that actually parses", () => {
    // #given the ask we quote at the user
    const original = parseFull("buy $20 of ETH at $2300")!;

    // #when they send back exactly what we suggested, plus a chain
    const again = parseFull(`${restate(original)} on base`);

    // #then it resolves to an order rather than falling through
    expect(again).not.toBeNull();
  });

  it("should carry the bracket through the suggestion", () => {
    // #given a protected limit buy that hit a which-chain prompt
    const original = parseFull("buy $20 of ETH at $2300, stop $2100, target $2600")!;

    // #when the user re-sends our suggestion
    const again = parseFull(`${restate(original)} on base`);

    // #then the protection survives — dropping it would hand them an
    // unprotected order for following our own advice
    expect([again?.bracket?.stopLoss.price, again?.bracket?.takeProfit.price]).toEqual(["2100", "2600"]);
  });

  it("should keep the entry intact alongside the bracket", () => {
    // #given the same protected order
    const original = parseFull("buy $20 of ETH at $2300, stop $2100, target $2600")!;

    // #when restated and re-parsed
    const again = parseFull(`${restate(original)} on base`);

    // #then size, price and chain all survive
    expect({ qty: again?.qty, price: again?.priceLevel, chain: again?.chain }).toEqual({ qty: "20", price: "2300", chain: "base" });
  });

  it("should round-trip a token-denominated sell", () => {
    // #given a sell, which is sized in tokens rather than dollars
    const original = parseFull("sell 2 ETH at $3000")!;

    // #when restated and re-parsed
    const again = parseFull(restate(original));

    // #then the quantity is not turned into a dollar figure
    expect({ qty: again?.qty, side: again?.side }).toEqual({ qty: "2", side: "sell" });
  });

  it("should round-trip a TWAP buy", () => {
    // #given a scheduled buy, also dollar-denominated
    const original = parseFull("buy $500 of ETH over 7 days")!;

    // #when restated and re-parsed
    const again = parseFull(restate(original));

    // #then the spend and the schedule both survive
    expect({ qty: again?.qty, orderType: again?.orderType }).toEqual({ qty: "500", orderType: "twap" });
  });
});
