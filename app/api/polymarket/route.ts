import { z } from "zod";
import { HttpError } from "@agentcash/router";
import { router } from "@/lib/agentcashRouter";
import { getTopMarkets } from "@/lib/polymarket";

// Paid, agent-discoverable prediction market odds — $0.01/call via x402. Reuses
// the same getTopMarkets() the free "pm pulse" / "odds on X" chat commands call.
export const POST = router
  .route({ path: "polymarket" })
  .paid("0.01")
  .body(z.object({
    topic: z.string().min(1).max(80).optional().describe("Omit for today's biggest-volume markets"),
    limit: z.number().int().min(1).max(10).default(5),
  }))
  .inputExample({ topic: "bitcoin", limit: 5 })
  .description("Live Polymarket odds and volume — by topic, or today's biggest movers if no topic given.")
  .handler(async ({ body }) => {
    const markets = await getTopMarkets(body.topic, body.limit);
    if (!markets.length) {
      throw new HttpError(body.topic ? `No active markets matching "${body.topic}".` : "No active markets right now.", 404);
    }
    return { topic: body.topic ?? null, markets };
  });
