import { NextRequest } from "next/server";
import { verifyMessage } from "viem";
import { saveSubscription, type PushSubscriptionRecord } from "@/lib/notifications";
import { getRedis } from "@/lib/redis";
import { buildChallengeMessage } from "@/lib/pushChallenge";

export const dynamic = "force-dynamic";

const ADDRESS_RE = /^0x[a-f0-9]{40}$/i;
const CHALLENGE_KEY_PREFIX = "push:challenge:";

// Stores a browser's Web Push subscription against the same identity
// (wallet address or anonId) that /api/chat uses for the sender — a watcher
// registered under that identity looks up this same key to send its alert.
//
// Wallet-address identities must prove ownership via a signed challenge
// (see /api/notifications/challenge) before a subscription is accepted —
// otherwise anyone could hijack another wallet's alert delivery by POSTing
// under their address. anonId identities (not a 0x address) skip this: an
// anonId is anonymous by design, there's nothing sensitive to protect.
export async function POST(req: NextRequest) {
  let body: { identity?: string; subscription?: PushSubscriptionRecord; signature?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const { identity, subscription, signature } = body;
  if (!identity || typeof identity !== "string") {
    return Response.json({ ok: false, error: "Missing identity." }, { status: 400 });
  }
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return Response.json({ ok: false, error: "Invalid push subscription." }, { status: 400 });
  }

  if (ADDRESS_RE.test(identity)) {
    if (!signature) {
      return Response.json({ ok: false, error: "Missing signature." }, { status: 400 });
    }
    const redis = getRedis();
    if (!redis) {
      return Response.json({ ok: false, error: "Notifications aren't configured on the server right now." }, { status: 503 });
    }
    const challengeKey = `${CHALLENGE_KEY_PREFIX}${identity.toLowerCase()}`;
    const nonce = await redis.get<string>(challengeKey);
    if (!nonce) {
      return Response.json({ ok: false, error: "Challenge expired — request a new one." }, { status: 400 });
    }
    const message = buildChallengeMessage(identity, nonce);
    const valid = await verifyMessage({ address: identity as `0x${string}`, message, signature: signature as `0x${string}` });
    if (!valid) {
      return Response.json({ ok: false, error: "Signature verification failed." }, { status: 401 });
    }
    await redis.del(challengeKey); // single-use
  }

  const saved = await saveSubscription(identity.toLowerCase(), subscription);
  if (!saved) {
    return Response.json({ ok: false, error: "Notifications aren't configured on the server right now." }, { status: 503 });
  }
  return Response.json({ ok: true });
}
