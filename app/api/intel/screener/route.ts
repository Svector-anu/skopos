import { NextRequest } from "next/server";
import { fetchScreenerServer, agentPaidEnabled } from "@/lib/smartMoneyServer";
import { checkIntelBudget, incrIntel } from "@/lib/usage";

export const dynamic = "force-dynamic";

// Agent-paid smart-money screener (discovery — no token needed). Same rail + budget.
export async function POST(req: NextRequest) {
  if (!agentPaidEnabled()) {
    return Response.json({ ok: false, error: "Agent-paid intel is not enabled." }, { status: 503 });
  }

  let chain: string | null = null;
  try {
    const body = await req.json();
    chain = typeof body?.chain === "string" ? body.chain : null;
  } catch {
    // empty body is fine — the screen is cross-chain by default
  }

  if (!(await checkIntelBudget())) {
    return Response.json({ ok: false, error: "Intel reads are at today's free limit. Try again tomorrow." }, { status: 429 });
  }

  const result = await fetchScreenerServer({ chain });
  if (result.ok) await incrIntel();
  return Response.json(result, { status: result.ok ? 200 : 502 });
}
