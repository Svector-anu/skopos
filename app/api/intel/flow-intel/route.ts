import { NextRequest } from "next/server";
import { fetchFlowIntelServer, agentPaidEnabled } from "@/lib/smartMoneyServer";
import { checkIntelBudget, incrIntel } from "@/lib/usage";
import { isTimeframe, type Timeframe } from "@/lib/timeframe";
import { isValidTokenTarget } from "@/lib/nansen";

export const dynamic = "force-dynamic";

// Agent-paid flow intelligence (net flow per wallet segment). Same rail + budget.
export async function POST(req: NextRequest) {
  if (!agentPaidEnabled()) {
    return Response.json({ ok: false, error: "Agent-paid intel is not enabled." }, { status: 503 });
  }

  let token: { symbol: string | null; address: string | null; chain: string | null };
  let timeframe: Timeframe | undefined;
  try {
    const body = await req.json();
    token = {
      symbol: typeof body?.token?.symbol === "string" ? body.token.symbol : null,
      address: typeof body?.token?.address === "string" ? body.token.address : null,
      chain: typeof body?.token?.chain === "string" ? body.token.chain : null,
    };
    timeframe = isTimeframe(body?.timeframe) ? body.timeframe : undefined;
  } catch {
    return Response.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  if (!token.address || !token.chain || !isValidTokenTarget(token.address, token.chain)) {
    return Response.json({ ok: false, error: "Couldn't locate this token on a supported chain." }, { status: 400 });
  }

  if (!(await checkIntelBudget())) {
    return Response.json({ ok: false, error: "Intel reads are at today's free limit. Try again tomorrow." }, { status: 429 });
  }

  const result = await fetchFlowIntelServer(token, timeframe);
  if (result.ok) await incrIntel();
  return Response.json(result, { status: result.ok ? 200 : 502 });
}
