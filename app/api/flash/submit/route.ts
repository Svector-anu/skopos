import { NextRequest } from "next/server";
import { submitFlashOrder, type FlashChain, type FlashOrderSide, type FlashOrderType, type FlashPriceTrigger, type FlashSubmitRequest } from "@/lib/flash";

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
  // Advanced order types (route.ts's resolveFlashOrderLeg) — Flash's /order
  // endpoint validates these independently of /quote and rejects a limit
  // order submitted without limitNotionalPrice even though the quote step
  // already required and returned one (confirmed live: a 400
  // VALIDATION_ERROR "limit orders require limitNotionalPrice" came back
  // from a real submit attempt before this was wired through). triggers/
  // twapBucketCount must echo the exact values used at quote time per
  // Flash's own spec, not be recomputed here.
  limitNotionalPrice?: string;
  triggers?: FlashPriceTrigger[];
  // Attached take-profit / stop-loss pair, signed client-side over its own
  // typed data. Passed through verbatim — every field here is either part of
  // what was signed or an echo Flash requires, so touching any of it
  // invalidates the signature.
  attachedBracket?: FlashSubmitRequest["attachedBracket"];
  twapBucketCount?: number;
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
    // Log which fields were actually missing — a bare 400 gave no way to
    // tell "wallet disconnected mid-flow, funderAddress went stale" apart
    // from "genuine client bug" without re-instrumenting on the fly.
    const missing = Object.entries({ targetChain, contraChain, targetAsset, contraAsset, side, qty, orderType, funderAddress, userSignature })
      .filter(([, v]) => !v).map(([k]) => k);
    console.error("[flash-submit] missing fields:", missing.join(", "));
    return Response.json({ error: `Missing required order fields: ${missing.join(", ")}.` }, { status: 400 });
  }

  try {
    const result = await submitFlashOrder({
      targetChain, contraChain, targetAsset, contraAsset, side, qty, orderType,
      funderAddress, userSignature,
      quoteId: body.quoteId,
      flashIntegratorFeeBps: body.flashIntegratorFeeBps,
      ...(body.attachedBracket ? { attachedBracket: body.attachedBracket } : {}),
      evmOrderTypedData: body.evmOrderTypedData,
      limitNotionalPrice: body.limitNotionalPrice,
      triggers: body.triggers,
      twapBucketCount: body.twapBucketCount,
    });
    return Response.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Order submission failed.";
    console.error("[flash-submit]", msg);
    return Response.json({ error: msg }, { status: 502 });
  }
}
