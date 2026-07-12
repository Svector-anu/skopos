import { NextRequest } from "next/server";
import { fetchHoldersServer, agentPaidEnabled } from "@/lib/smartMoneyServer";
import { checkIntelBudget, incrIntel } from "@/lib/usage";
import { isValidTokenTarget } from "@/lib/nansen";
import { checkRateLimit, trustedIp, corsHeadersFor } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// Agent-paid holder read. Same rail as /api/intel/smart-money — Skopos's wallet
// fronts the x402 fee, the shared daily budget guards it, and the budget only
// increments on a settled read so failures are free. Per-IP rate limit is
// shared across all 5 intel routes via the same "intel" bucket key — 5/min
// combined, not 5/min each, so rotating endpoints cannot multiply the
// allowance. Tighter than chat's 30/min since this spends real money per call.
export async function POST(req: NextRequest) {
  const corsHeaders = corsHeadersFor(req);
  if (!checkRateLimit("intel", trustedIp(req), 5)) {
    return Response.json({ ok: false, error: "Too many requests — slow down and try again in a minute." }, { status: 429, headers: corsHeaders });
  }
  if (!agentPaidEnabled()) {
    return Response.json({ ok: false, error: "Agent-paid intel is not enabled." }, { status: 503, headers: corsHeaders });
  }

  let token: { symbol: string | null; address: string | null; chain: string | null };
  try {
    const body = await req.json();
    token = {
      symbol: typeof body?.token?.symbol === "string" ? body.token.symbol : null,
      address: typeof body?.token?.address === "string" ? body.token.address : null,
      chain: typeof body?.token?.chain === "string" ? body.token.chain : null,
    };
  } catch {
    return Response.json({ ok: false, error: "Invalid request body." }, { status: 400, headers: corsHeaders });
  }

  if (!token.address || !token.chain || !isValidTokenTarget(token.address, token.chain)) {
    return Response.json({ ok: false, error: "Couldn't locate this token on a supported chain." }, { status: 400, headers: corsHeaders });
  }

  if (!(await checkIntelBudget())) {
    return Response.json(
      { ok: false, error: "Intel reads are at today's free limit. Try again tomorrow." },
      { status: 429, headers: corsHeaders },
    );
  }

  const result = await fetchHoldersServer(token);
  if (result.ok) await incrIntel();

  return Response.json(result, { status: result.ok ? 200 : 502, headers: corsHeaders });
}
