import { Redis } from "@upstash/redis";

// Subscription entitlement store. A paid wallet gets a time-boxed pass written to
// Upstash as sub:<wallet> = expiry epoch (seconds, UTC). isEntitled() is the
// read-only gate consulted before the Smart daily counter — an active sub skips
// the cap entirely. grantSub() is called by /api/subscribe after a verified x402
// payment. The $skopos token-gate is deferred: entitlement is active-subscription
// only (v1), no "buy $skopos" path.
//
// Mirrors lib/usage.ts (same Upstash client contract). isEntitled fails CLOSED
// (no sub data or Redis error → not entitled); the user then falls through to the
// free counter, which itself fails open — so a Redis outage degrades to "everyone
// gets free Smart", never "paid user blocked".

const DEFAULT_SUB_DAYS = 30;
const SECONDS_PER_DAY = 60 * 60 * 24;

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

// Renewals extend rather than reset: a wallet paying before expiry stacks the new
// period onto the remaining time. TTL tracks the absolute expiry so the key
// self-cleans once the pass lapses.
export async function grantSub(wallet: string, days = DEFAULT_SUB_DAYS): Promise<number> {
  const now = nowSeconds();
  const redis = getRedis();
  if (!redis) {
    console.warn("[subscription] Upstash not configured — sub not persisted");
    return now + days * SECONDS_PER_DAY;
  }
  try {
    const current = Number((await redis.get<number>(subKey(wallet))) ?? 0);
    const base = Math.max(now, current);
    const expiry = base + days * SECONDS_PER_DAY;
    await redis.set(subKey(wallet), expiry, { ex: expiry - now });
    return expiry;
  } catch (err) {
    console.error("[subscription] grant failed:", err instanceof Error ? err.message : err);
    return now + days * SECONDS_PER_DAY;
  }
}
