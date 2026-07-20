import { NextRequest } from "next/server";
import { cancelFlashOrder } from "@/lib/flash";

export const dynamic = "force-dynamic";

// Mirrors app/api/flash/submit/route.ts's shape — the browser signs the
// cancel message client-side (only the funder wallet's key can authorize a
// cancel), this route makes the actual call, since Flash's
// /orders/{orderId}/cancel endpoint needs Skopos's own x-definitive-api-key
// header, which the browser never gets directly.
interface CancelBody {
  orderId?: string;
  cancelMessage?: string;
  userSignature?: string;
}

export async function POST(req: NextRequest) {
  let body: CancelBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { orderId, cancelMessage, userSignature } = body;
  if (!orderId || !cancelMessage || !userSignature) {
    const missing = Object.entries({ orderId, cancelMessage, userSignature })
      .filter(([, v]) => !v).map(([k]) => k);
    return Response.json({ error: `Missing required fields: ${missing.join(", ")}.` }, { status: 400 });
  }

  try {
    const result = await cancelFlashOrder(orderId, cancelMessage, userSignature);
    return Response.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Order cancellation failed.";
    console.error("[flash-cancel]", msg);
    return Response.json({ error: msg }, { status: 502 });
  }
}
