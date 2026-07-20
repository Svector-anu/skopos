import { NextRequest } from "next/server";
import { getRedis } from "@/lib/redis";
import { buildChallengeMessage } from "@/lib/pushChallenge";

export const dynamic = "force-dynamic";

const ADDRESS_RE = /^0x[a-f0-9]{40}$/i;
const CHALLENGE_TTL_SECONDS = 300; // 5 min — long enough for a wallet prompt, short enough to bound replay risk
const CHALLENGE_KEY_PREFIX = "push:challenge:";

// Issues a single-use, short-lived nonce for a wallet address to sign before
// /api/notifications/subscribe will accept a subscription under that
// identity — see that route for the verification side. Anonymous (non-0x)
// identities don't call this at all; there's nothing sensitive to prove
// ownership of for an anonId.
//
// The endpoint being registered is captured here and stored alongside the
// nonce (not trusted from the later subscribe call) so the signature binds
// to that ONE subscription — subscribe re-derives the message from what was
// actually stored and rejects if the submitted subscription's endpoint
// doesn't match, so a signature obtained for one endpoint can't be replayed
// against a different (attacker-controlled) one.
export async function GET(req: NextRequest) {
  const identity = req.nextUrl.searchParams.get("identity");
  const endpoint = req.nextUrl.searchParams.get("endpoint");
  if (!identity || !ADDRESS_RE.test(identity)) {
    return Response.json({ ok: false, error: "Invalid or missing address." }, { status: 400 });
  }
  if (!endpoint) {
    return Response.json({ ok: false, error: "Missing push endpoint." }, { status: 400 });
  }

  const redis = getRedis();
  if (!redis) {
    return Response.json({ ok: false, error: "Notifications aren't configured on the server right now." }, { status: 503 });
  }

  const nonce = crypto.randomUUID();
  await redis.set(
    `${CHALLENGE_KEY_PREFIX}${identity.toLowerCase()}`,
    JSON.stringify({ nonce, endpoint }),
    { ex: CHALLENGE_TTL_SECONDS },
  );

  return Response.json({ message: buildChallengeMessage(identity, nonce, endpoint) });
}
