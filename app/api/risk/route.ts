import { z } from "zod";
import { HttpError } from "@agentcash/router";
import { router } from "@/lib/agentcashRouter";
import { scanToken } from "@/lib/dexscreener";

// Paid, agent-discoverable token safety scan — $0.02/call via x402. Reuses the
// same scanToken() the free "scan X risk" chat command calls (lib/dexscreener.ts).
export const POST = router
  .route({ path: "risk" })
  .paid("0.02")
  .body(z.object({ query: z.string().min(1).max(64).describe("Token symbol or contract address") }))
  .inputExample({ query: "PEPE" })
  .description("Verdict-first token risk scan — liquidity, volume, honeypot flags, risk score.")
  .handler(async ({ body }) => {
    const risk = await scanToken(body.query.trim());
    if (!risk) {
      throw new HttpError(`Couldn't find "${body.query}" on any supported chain.`, 404);
    }
    return {
      symbol: risk.symbol,
      name: risk.name,
      priceUsd: risk.priceUsd,
      score: risk.score,
      label: risk.label,
      totalLiquidityUsd: risk.totalLiquidityUsd,
      volume24h: risk.volume24h,
      marketCap: risk.marketCap,
      priceChange24h: risk.priceChange24h,
      pairCount: risk.pairCount,
      flags: risk.flags,
    };
  });
