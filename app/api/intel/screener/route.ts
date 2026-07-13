import { NextRequest } from "next/server";
import { fetchScreenerServer, agentPaidEnabled } from "@/lib/smartMoneyServer";
import { checkIntelBudget, incrIntel } from "@/lib/usage";
import { isTimeframe, type Timeframe } from "@/lib/timeframe";
import { toNansenChain } from "@/lib/nansen";
import { checkRateLimit, trustedIp, corsHeadersFor } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// Agent-paid smart-money screener (discovery — no token needed). Same rail + budget.
// Per-IP rate limit is shared across all 5 intel routes via the same "intel" bucket key — 5/min combined, not 5/min each, so rotating endpoints cannot multiply the allowance.
export async function POST(req: NextRequest) {
  const corsHeaders = corsHeadersFor(req);
  if (!checkRateLimit("intel", trustedIp(req), 5)) {
    return Response.json({ ok: false, error: "Too many requests — slow down and try again in a minute." }, { status: 429, headers: corsHeaders });
  }
  if (!agentPaidEnabled()) {
    return Response.json({ ok: false, error: "Agent-paid intel is not enabled." }, { status: 503, headers: corsHeaders });
  }

  let chain: string | null = null;
  let timeframe: Timeframe | undefined;
  try {
    const body = await req.json();
    chain = typeof body?.chain === "string" ? body.chain : null;
    timeframe = isTimeframe(body?.timeframe) ? body.timeframe : undefined;
  } catch {
    // empty body is fine — the screen is cross-chain by default
  }

  if (chain && !toNansenChain(chain)) {
    return Response.json({ ok: false, error: "Unsupported chain." }, { status: 400, headers: corsHeaders });
  }

  if (!(await checkIntelBudget())) {
    return Response.json({ ok: false, error: "Intel reads are at today's free limit. Try again tomorrow." }, { status: 429, headers: corsHeaders });
  }

  const result = await fetchScreenerServer({ chain, timeframe });
  if (result.ok) await incrIntel();
  return Response.json(result, { status: result.ok ? 200 : 502, headers: corsHeaders });
}
