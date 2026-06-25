import { NextRequest } from "next/server";
import { getSmartMoneyQuote } from "@/lib/nansen";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let symbol: string | null = null;
  let address: string | null = null;
  try {
    const body = await req.json();
    symbol = typeof body.symbol === "string" ? body.symbol : null;
    address = typeof body.address === "string" ? body.address : null;
  } catch {
    // empty body is allowed — the quote is token-agnostic
  }

  const quote = await getSmartMoneyQuote();
  if (!quote) {
    return Response.json({ ok: false, error: "Smart-money quote unavailable right now." }, { status: 502 });
  }

  return Response.json({ ok: true, token: { symbol, address }, quote });
}
