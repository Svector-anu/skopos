import { z } from "zod";
import { NextResponse } from "next/server";
import { HttpError } from "@agentcash/router";
import { router } from "@/lib/agentcashRouter";
import { scanToken } from "@/lib/dexscreener";
import { getSniperCheck, sniperCheckSupportsChain } from "@/lib/sniperCheck";
import { getHolderConcentration } from "@/lib/holderConcentration";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

// A browser GET on a paid, POST-only route deserves more than a bare 405 —
// same 418 teapot pattern as app/api/chat/route.ts's GET, own copy. The curl
// example doubles as the machine-readable contract for an agent/LLM scraping
// the page, not just a joke for a human who clicked a link.
export function GET(): NextResponse {
  const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>skopos api · 418</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:grid;place-items:center;background:#000;color:#e8e8e8;font-family:'JetBrains Mono',ui-monospace,monospace;padding:24px;background-image:radial-gradient(60% 50% at 72% -10%,rgba(245,184,0,.16),transparent 70%)}
.term{width:100%;max-width:660px;background:#0c0c0c;border:1px solid rgba(255,255,255,.1);border-radius:16px;overflow:hidden;box-shadow:0 30px 90px -30px #000}
.bar{display:flex;gap:8px;align-items:center;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.07)}
.bar i{width:11px;height:11px;border-radius:50%;display:inline-block}
.r{background:#ff5f57}.y{background:#F5B800}.g{background:#28c840}
.bar b{margin-left:auto;color:rgba(255,255,255,.5);letter-spacing:.14em;font-size:13px;font-weight:700}
.bar b span{color:#F5B800}
.body{padding:22px;font-size:14px;line-height:1.7}
.p{color:#F5B800}.dim{color:rgba(255,255,255,.45)}
p{margin:14px 0}
pre{margin:14px 0;padding:14px;background:rgba(245,184,0,.05);border:1px solid rgba(245,184,0,.16);border-radius:10px;white-space:pre-wrap;word-break:break-word;font-size:12.5px;color:#fff}
a{color:#F5B800;text-decoration:none}
</style></head><body>
<div class="term">
  <div class="bar"><i class="r"></i><i class="y"></i><i class="g"></i><b>&#10022; <span>skopos</span></b></div>
  <div class="body">
    <div><span class="p">&gt;</span> GET /api/sniper-check</div>
    <div class="dim">418 &mdash; i'm a teapot &#129380; (well, a paid, post-only api)</div>
    <p>early buyers, concentrated wallets &mdash; the stuff a chart won't show you. sniper detection + top-10 holder concentration, any token, one paid call:</p>
<pre>curl -sX POST https://www.tryskopos.xyz/api/sniper-check \\
  -H 'content-type: application/json' \\
  -d '{"tokenAddress":"0x...","chain":"base"}'</pre>
    <div class="dim">&rarr; first call 402s with the price. an x402 wallet pays it and retries. flags land straight on the risk card: SNIPED, CONCENTRATED.</div>
    <p class="dim" style="margin-top:16px">$0.15/call via x402 &middot; no key, no signup.<br>agent-payable &middot; <a href="https://www.tryskopos.xyz">tryskopos.xyz</a></p>
  </div>
</div>
</body></html>`;
  return new NextResponse(html, {
    status: 418,
    headers: { "content-type": "text/html; charset=utf-8", "x-skopos": "priced per call, no dashboard", ...NO_CACHE },
  });
}

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
