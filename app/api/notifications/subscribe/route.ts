import { NextRequest } from "next/server";
import { saveSubscription, type PushSubscriptionRecord } from "@/lib/notifications";

export const dynamic = "force-dynamic";

// Stores a browser's Web Push subscription against the same identity
// (wallet address or anonId) that /api/chat uses for the sender — a watcher
// registered under that identity looks up this same key to send its alert.
export async function POST(req: NextRequest) {
  let body: { identity?: string; subscription?: PushSubscriptionRecord };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const { identity, subscription } = body;
  if (!identity || typeof identity !== "string") {
    return Response.json({ ok: false, error: "Missing identity." }, { status: 400 });
  }
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return Response.json({ ok: false, error: "Invalid push subscription." }, { status: 400 });
  }

  const saved = await saveSubscription(identity.toLowerCase(), subscription);
  if (!saved) {
    return Response.json({ ok: false, error: "Notifications aren't configured on the server right now." }, { status: 503 });
  }
  return Response.json({ ok: true });
}
