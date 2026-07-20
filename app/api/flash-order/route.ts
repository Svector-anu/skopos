import { z } from "zod";
import { HttpError } from "@agentcash/router";
import { router } from "@/lib/agentcashRouter";
import { resolveFlashOrderLeg, type FlashOrderIntent } from "@/app/api/chat/route";

const SITE = "https://www.tryskopos.xyz";

// Paid, agent-discoverable Flash advanced-order quote — $0.02/call via x402,
// same price class as /api/quote. Structured input, but calls the exact same
// resolveFlashOrderLeg() the free chat order flow uses, so quote accuracy
// never diverges between the two surfaces. Non-custodial like everything
// else: returns the priced route + a sign-in link whose prefilled message
// round-trips through the chat parser — never the EIP-712 payloads, which
// only the user's own wallet should ever see.
function durationPhrase(seconds: number): string {
  if (seconds % 604800 === 0) { const n = seconds / 604800; return `${n} week${n > 1 ? "s" : ""}`; }
  if (seconds % 86400 === 0)  { const n = seconds / 86400;  return `${n} day${n > 1 ? "s" : ""}`; }
  const n = Math.max(1, Math.round(seconds / 3600));
  return `${n} hour${n > 1 ? "s" : ""}`;
}

export const POST = router
  .route({ path: "flash-order" })
  .paid("0.02")
  .body(z.object({
    orderType: z.enum(["limit", "stop-loss", "take-profit", "twap"]),
    side: z.enum(["buy", "sell"]).optional(),
    token: z.string().min(1),
    qty: z.string().min(1),
    priceLevel: z.string().optional(),
    durationSeconds: z.number().int().min(300).optional(),
    twapBucketCount: z.number().int().positive().optional(),
    chain: z.string().optional(),
    senderAddress: z.string().min(1),
  }))
  .inputExample({ orderType: "stop-loss", token: "ETH", qty: "2", priceLevel: "2000", chain: "arbitrum", senderAddress: "0xYourWallet" })
  .description("Advanced-order quote (limit / stop-loss / take-profit / TWAP) via Flash on Robinhood Chain, Ethereum, Base, Arbitrum, Optimism, Polygon, BSC, or Avalanche. qty is the spent asset — USD on a buy, token units on a sell. Returns the priced route and a sign-in link; signing happens non-custodially in the Skopos app, never here.")
  .handler(async ({ body }) => {
    const isTrigger = body.orderType === "stop-loss" || body.orderType === "take-profit";
    const side = isTrigger ? "sell" : body.side;
    if (!side) throw new HttpError(`side is required for ${body.orderType} orders.`, 422);
    if (body.orderType !== "twap" && !body.priceLevel) {
      throw new HttpError(`priceLevel is required for ${body.orderType} orders.`, 422);
    }
    if (body.orderType === "twap" && !body.durationSeconds) {
      throw new HttpError("durationSeconds is required for twap orders (minimum 300).", 422);
    }

    const order: FlashOrderIntent = {
      side,
      orderType: body.orderType,
      token: body.token,
      qty: body.qty,
      ...(body.priceLevel ? { priceLevel: body.priceLevel } : {}),
      ...(isTrigger ? { triggerType: body.orderType === "stop-loss" ? "lower" as const : "upper" as const } : {}),
      ...(body.durationSeconds ? { durationSeconds: body.durationSeconds } : {}),
      ...(body.twapBucketCount ? { twapBucketCount: body.twapBucketCount } : {}),
      ...(body.chain ? { chain: body.chain } : {}),
    };
    const result = await resolveFlashOrderLeg(order, body.senderAddress);
    if (!result.ok) throw new HttpError(result.text, 422);

    const sym = body.token.toUpperCase();
    const message =
      body.orderType === "limit"
        ? side === "buy"
          ? `buy $${body.qty} of ${sym} at $${body.priceLevel}`
          : `sell ${body.qty} ${sym} at $${body.priceLevel}`
        : body.orderType === "stop-loss"
          ? `sell ${body.qty} ${sym} if it drops below $${body.priceLevel}`
          : body.orderType === "take-profit"
            ? `sell ${body.qty} ${sym} when it hits $${body.priceLevel}`
            : side === "buy"
              ? `buy $${body.qty} of ${sym} over ${durationPhrase(body.durationSeconds!)}`
              : `sell ${body.qty} ${sym} over ${durationPhrase(body.durationSeconds!)}`;
    const withChain = body.chain ? `${message} on ${body.chain}` : message;

    return {
      intent: result.intent,
      route: result.route,
      orderType: body.orderType,
      side,
      ...(body.priceLevel ? { priceLevel: body.priceLevel } : {}),
      ...(body.durationSeconds ? { durationSeconds: body.durationSeconds } : {}),
      signInUrl: `${SITE}/app?q=${encodeURIComponent(withChain)}`,
    };
  });
