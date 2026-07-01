import { NextRequest } from "next/server";
import { fetchSmartMoneyServer, agentPaidEnabled } from "@/lib/smartMoneyServer";
import { checkIntelBudget, incrIntel } from "@/lib/usage";

export const dynamic = "force-dynamic";

// Agent-paid smart-money read. Skopos's own wallet fronts the x402 micropayment
// (lib/smartMoneyServer.ts), so the browser needs no wallet, no chain switch, no
// signature. A global daily budget (lib/usage.ts) guards the wallet from runaway
// clicks. Only increments the budget on a settled read, so failures are free.
export async function POST(req: NextRequest) {
  if (!agentPaidEnabled()) {
    return Response.json({ ok: false, error: "Agent-paid intel is not enabled." }, { status: 503 });
  }

  let token: { symbol: string | null; address: string | null; chain: string | null };
  let direction: "BUY" | "SELL";
  try {
    const body = await req.json();
    token = {
      symbol: typeof body?.token?.symbol === "string" ? body.token.symbol : null,
      address: typeof body?.token?.address === "string" ? body.token.address : null,
      chain: typeof body?.token?.chain === "string" ? body.token.chain : null,
    };
    direction = body?.direction === "SELL" ? "SELL" : "BUY";
  } catch {
    return Response.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  if (!token.address || !token.chain) {
    return Response.json({ ok: false, error: "Couldn't locate this token on a supported chain." }, { status: 400 });
  }

  if (!(await checkIntelBudget())) {
    return Response.json(
      { ok: false, error: "Smart-money reads are at today's free limit. Try again tomorrow." },
      { status: 429 },
    );
  }

  const result = await fetchSmartMoneyServer(token, direction);
  if (result.ok) await incrIntel();

  return Response.json(result, { status: result.ok ? 200 : 502 });
}
