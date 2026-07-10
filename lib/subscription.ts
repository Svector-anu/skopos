import { Redis } from "@upstash/redis";

// Subscription entitlement store. A paid wallet gets a time-boxed pass written to
// Upstash as sub:<wallet> = expiry epoch (seconds, UTC). isEntitled() is the
// read-only gate consulted before the Smart daily counter — an active sub skips
// the cap entirely. The grant side lives in x402/skopos-subscribe/index.ts (a
// separate deployment, not part of this Next app), which writes the same
// sub:<wallet> key directly via raw Upstash REST calls. The $skopos token-gate
// is deferred: entitlement is active-subscription only (v1), no "buy $skopos" path.
//
// Mirrors lib/usage.ts (same Upstash client contract). isEntitled fails CLOSED
// (no sub data or Redis error → not entitled); the user then falls through to the
// free counter, which itself fails open — so a Redis outage degrades to "everyone
// gets free Smart", never "paid user blocked".

let client: Redis | null = null;
function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  if (!client) client = new Redis({ url, token });
  return client;
}

function subKey(wallet: string): string {
  return `sub:${wallet.toLowerCase()}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export async function isEntitled(wallet: string | null | undefined): Promise<boolean> {
  if (!wallet || !wallet.startsWith("0x")) return false;
  const redis = getRedis();
  if (!redis) return false;
  try {
    const expiry = Number((await redis.get<number>(subKey(wallet))) ?? 0);
    return expiry > nowSeconds();
  } catch (err) {
    console.error("[subscription] entitlement check failed — fail-closed:", err instanceof Error ? err.message : err);
    return false;
  }
}
