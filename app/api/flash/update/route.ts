import { NextRequest } from "next/server";
import { updateFlashOrder, FlashUpdateError, type FlashUpdateRequest, type FlashPriceTrigger } from "@/lib/flash";

export const dynamic = "force-dynamic";

// Third of the Flash trio that follows the same non-custodial shape as
// app/api/flash/submit and app/api/flash/cancel: the browser signs with the
// funder wallet (only it holds the key), this route makes the call, because
// Flash's PATCH /orders/{orderId} needs Skopos's own x-definitive-api-key
// header, which the browser never receives.
//
// The message is built and signed client-side rather than here on purpose.
// It carries an "Issued At" stamp that must be within a minute of Flash's
// clock, and it is what the wallet shows the user before they approve — so
// the bytes they read have to be the exact bytes that get sent. Rebuilding
// them server-side would let the two diverge silently.
interface UpdateBody {
  orderId?: string;
  updateMessage?: string;
  userSignature?: string;
  limitNotionalPrice?: string;
  limitCrossPrice?: string;
  trigger?: FlashPriceTrigger;
}

// Flash overloads both of its rejection codes, so map them to something a
// user can act on instead of surfacing a bare status. A 404 in particular
// does NOT mean "no such order" — a bad signature or a single wrong byte in
// the message lands here too, which is the failure mode most likely to bite.
function messageFor(status: number): string {
  if (status === 404) {
    return "Flash rejected the update — the order is gone, or the signature didn't match. Re-check your orders and try again.";
  }
  if (status === 422) {
    return "This order can't be updated anymore — it already filled, was cancelled, or has another update still in flight. Re-check your orders.";
  }
  if (status === 429) {
    return "Too many requests to Flash right now — wait a moment and try again.";
  }
  return "Couldn't update the order right now — try again in a moment.";
}

export async function POST(req: NextRequest) {
  let body: UpdateBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { orderId, updateMessage, userSignature, limitNotionalPrice, limitCrossPrice, trigger } = body;
  if (!orderId || !updateMessage || !userSignature) {
    const missing = Object.entries({ orderId, updateMessage, userSignature })
      .filter(([, v]) => !v).map(([k]) => k);
    return Response.json({ error: `Missing required fields: ${missing.join(", ")}.` }, { status: 400 });
  }

  // At least one price, or there is nothing to change and Flash 422s.
  if (!limitNotionalPrice && !limitCrossPrice && !trigger) {
    return Response.json({ error: "No new price supplied." }, { status: 400 });
  }
  // The two limit bases are mutually exclusive in Flash's schema; sending
  // both is a client bug, and catching it here keeps the failure legible
  // rather than arriving as a generic 400 from upstream.
  if (limitNotionalPrice && limitCrossPrice) {
    return Response.json({ error: "Send exactly one limit price basis." }, { status: 400 });
  }
  if (trigger && trigger.notionalPrice && trigger.crossPrice) {
    return Response.json({ error: "Send exactly one trigger price basis." }, { status: 400 });
  }

  const payload: FlashUpdateRequest = {
    updateMessage,
    userSignature,
    ...(limitNotionalPrice ? { limitNotionalPrice } : {}),
    ...(limitCrossPrice ? { limitCrossPrice } : {}),
    ...(trigger ? { trigger } : {}),
  };

  try {
    const result = await updateFlashOrder(orderId, payload);
    return Response.json(result);
  } catch (err) {
    if (err instanceof FlashUpdateError) {
      console.error(`[flash-update] ${err.status}: ${err.detail.slice(0, 300)}`);
      // Mirror Flash's own status so the client can branch, rather than
      // flattening every rejection into a 502 the way cancel does.
      return Response.json({ error: messageFor(err.status) }, { status: err.status });
    }
    const msg = err instanceof Error ? err.message : "Order update failed.";
    console.error("[flash-update]", msg);
    return Response.json({ error: messageFor(0) }, { status: 502 });
  }
}
