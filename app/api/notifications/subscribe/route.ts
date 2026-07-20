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
    const raw = await redis.get<string>(challengeKey);
    if (!raw) {
      return Response.json({ ok: false, error: "Challenge expired — request a new one." }, { status: 400 });
    }
    let nonce: string, challengeEndpoint: string;
    try {
      // Upstash's client sometimes auto-deserializes a JSON string value to
      // an object depending on config — same defensive parse already used
      // in lib/notifications.ts's getSubscription for the same reason.
      const parsed = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as { nonce: string; endpoint: string };
      nonce = parsed.nonce;
      challengeEndpoint = parsed.endpoint;
    } catch {
      return Response.json({ ok: false, error: "Challenge expired — request a new one." }, { status: 400 });
    }
    // The signature only ever authorized THIS endpoint — reject before even
    // attempting verification if the submitted subscription is a different
    // one, so a signature can't be lifted and replayed against another.
    if (subscription.endpoint !== challengeEndpoint) {
      return Response.json({ ok: false, error: "Subscription doesn't match the signed challenge." }, { status: 401 });
    }
    const message = buildChallengeMessage(identity, nonce, challengeEndpoint);
    let valid: boolean;
    try {
      valid = await verifyMessage({ address: identity as `0x${string}`, message, signature: signature as `0x${string}` });
    } catch {
      // viem throws on a malformed signature (wrong length, non-hex, etc.)
      // rather than returning false — treat that the same as a failed check.
      valid = false;
    }
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
