import { Redis } from "@upstash/redis";
import type { TokenRisk } from "./dexscreener";

// Scorecard for token-pick calls (route.ts's "token pick" block). A capped
// Redis list, not a database — this is a lightweight track record, not an
// audit log. Fails open (no Upstash configured → tracker is silently inert,
// picks just don't get recorded) since it's a nice-to-have, not load-bearing.

const LOG_KEY   = "picks:log";
const MAX_ITEMS = 50;

let client: Redis | null = null;
function getRedis(): Redis | null {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  if (!client) client = new Redis({ url, token });
  return client;
}

export interface StoredPick {
  symbol: string;
  name: string;
  entryPriceUsd: number | null;
  ts: number;
}

export async function recordPick(risk: TokenRisk): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const entry: StoredPick = {
    symbol: risk.symbol,
    name: risk.name,
    entryPriceUsd: risk.priceUsd ? Number(risk.priceUsd) : null,
    ts: Date.now(),
  };
  try {
    await redis.lpush(LOG_KEY, JSON.stringify(entry));
    await redis.ltrim(LOG_KEY, 0, MAX_ITEMS - 1);
  } catch {
    // fail open — losing a track-record entry is not worth surfacing an error
  }
}

export async function getRecentPicks(limit = 10): Promise<StoredPick[]> {
  const redis = getRedis();
  if (!redis) return [];
  try {
    const raw = await redis.lrange<string>(LOG_KEY, 0, limit - 1);
    return raw
      .map((r) => {
        try { return JSON.parse(typeof r === "string" ? r : JSON.stringify(r)) as StoredPick; }
        catch { return null; }
      })
      .filter((p): p is StoredPick => p !== null);
  } catch {
    return [];
  }
}
