import { NextRequest } from "next/server";
import { fetchHoldersServer, agentPaidEnabled } from "@/lib/smartMoneyServer";
import { checkIntelBudget, incrIntel } from "@/lib/usage";
import { isValidTokenTarget } from "@/lib/nansen";

export const dynamic = "force-dynamic";

// Agent-paid holder read. Same rail as /api/intel/smart-money — Skopos's wallet
// fronts the x402 fee, the shared daily budget guards it, and the budget only
// increments on a settled read so failures are free.
export async function POST(req: NextRequest) {
  if (!agentPaidEnabled()) {
    return Response.json({ ok: false, error: "Agent-paid intel is not enabled." }, { status: 503 });
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
    return Response.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  if (!token.address || !token.chain || !isValidTokenTarget(token.address, token.chain)) {
    return Response.json({ ok: false, error: "Couldn't locate this token on a supported chain." }, { status: 400 });
  }

  if (!(await checkIntelBudget())) {
    return Response.json(
      { ok: false, error: "Intel reads are at today's free limit. Try again tomorrow." },
      { status: 429 },
    );
  }

  const result = await fetchHoldersServer(token);
  if (result.ok) await incrIntel();

  return Response.json(result, { status: result.ok ? 200 : 502 });
}
