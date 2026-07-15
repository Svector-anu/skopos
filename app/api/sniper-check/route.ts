import { z } from "zod";
import { HttpError } from "@agentcash/router";
import { router } from "@/lib/agentcashRouter";
import { scanToken } from "@/lib/dexscreener";
import { getSniperCheck, sniperCheckSupportsChain } from "@/lib/sniperCheck";
import { getHolderConcentration } from "@/lib/holderConcentration";

// Paid sniper + holder-concentration bundle — $0.15/call via x402. Pays HYRE
// Agent ($0.04, sniper detection, Base-only) and Nansen TGM's tgm/holders
// ($0.01–0.05 typical, see docs/paid-data-sources.md) out of Skopos's own
// agent wallet (lib/x402Agent.ts) and resells combined, same margin pattern
// as app/api/smart-money/route.ts. Base scan reuses scanToken()
// (lib/dexscreener.ts) — same free-path logic every other risk-adjacent
// route reuses.
//
// Holder concentration originally targeted x402 Trading Hub ($0.14/call) but
// that origin is confirmed dead (404 DEPLOYMENT_NOT_FOUND straight from
// Vercel's edge) — replaced with lib/holderConcentration.ts's Nansen-backed
// implementation, which reuses the same tgm/holders read already live
// elsewhere in this repo instead of a second unreliable source.
export const POST = router
  .route({ path: "sniper-check" })
  .paid("0.15")
  .body(
    z.object({
      tokenAddress: z.string().min(1).max(64).describe("Token contract address (or mint for Solana)"),
      chain: z.string().min(1).max(32).describe('Chain slug, e.g. "base", "ethereum", "solana"'),
    }),
  )
  .inputExample({ tokenAddress: "0x6982508145454ce325ddbe47a25d4ec3d2311933", chain: "ethereum" })
  .description(
    "Sniper detection + top-10 holder concentration for a token. Sniper detection is currently Base-only " +
      "(Skopos's agent wallet can't yet pay Solana- or SKALE-priced endpoints); holder concentration runs on " +
      "any Nansen-supported chain.",
  )
  .handler(async ({ body }) => {
    const tokenAddress = body.tokenAddress.trim();
    const chain = body.chain.trim().toLowerCase();

    const [riskResult, sniperResult, concentrationResult] = await Promise.allSettled([
      scanToken(tokenAddress),
      getSniperCheck(chain, tokenAddress),
      getHolderConcentration(chain, tokenAddress),
    ]);

    const risk = riskResult.status === "fulfilled" ? riskResult.value : null;
    if (!risk) {
      throw new HttpError(`Couldn't find "${tokenAddress}" on any supported chain.`, 404);
    }

    const sniper = sniperResult.status === "fulfilled" ? sniperResult.value : null;
    const concentration = concentrationResult.status === "fulfilled" ? concentrationResult.value : null;

    const flags = [...risk.flags];
    if (sniper && sniper.signal === "snipe" && sniper.confidence > 0.7) flags.push("SNIPED");
    if (concentration && concentration.top10Pct > 50) flags.push("CONCENTRATED");

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
      flags,
      sniper: sniper ? { signal: sniper.signal, confidence: sniper.confidence, insight: sniper.insight } : null,
      sniperSupportedChain: sniperCheckSupportsChain(chain),
      top10HolderPct: concentration?.top10Pct ?? null,
    };
  });
