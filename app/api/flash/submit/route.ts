import { NextRequest } from "next/server";
import { submitFlashOrder, type FlashChain, type FlashOrderSide, type FlashOrderType } from "@/lib/flash";

export const dynamic = "force-dynamic";

// Second half of the Flash (Robinhood Chain) buy flow — app/api/chat/route.ts's
// resolveFlashLeg() builds the quote + EIP-712 orderTypedData; the browser
// signs it client-side (FlashExecuteButton, app/app/page.tsx) since only the
// user's wallet holds the key. This route takes that signature and makes the
// actual submit call, because Flash's /order endpoint needs Skopos's own
// x-definitive-api-key header (lib/flash.ts) — the browser never gets that
// key directly, same non-custodial-but-server-mediated shape as every other
// paid data source in this repo.
interface SubmitBody {
  targetChain?: FlashChain;
  contraChain?: FlashChain;
  targetAsset?: string;
  contraAsset?: string;
  side?: FlashOrderSide;
  qty?: string;
  orderType?: FlashOrderType;
  funderAddress?: string;
  quoteId?: string;
  flashIntegratorFeeBps?: string;
  userSignature?: string;
  evmOrderTypedData?: string;
}

export async function POST(req: NextRequest) {
  let body: SubmitBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const {
    targetChain, contraChain, targetAsset, contraAsset, side, qty, orderType,
    funderAddress, userSignature,
  } = body;
  if (!targetChain || !contraChain || !targetAsset || !contraAsset || !side || !qty || !orderType || !funderAddress || !userSignature) {
    return Response.json({ error: "Missing required order fields." }, { status: 400 });
  }

  try {
    const result = await submitFlashOrder({
      targetChain, contraChain, targetAsset, contraAsset, side, qty, orderType,
      funderAddress, userSignature,
      quoteId: body.quoteId,
      flashIntegratorFeeBps: body.flashIntegratorFeeBps,
      evmOrderTypedData: body.evmOrderTypedData,
    });
    return Response.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Order submission failed.";
    console.error("[flash-submit]", msg);
    return Response.json({ error: msg }, { status: 502 });
  }
}
