import { getRedis } from "./redis";

// Shared registration registry for the three standing-watch features
// (price-alert, monitor-polymarket, onchain-monitor) — same missing
// primitive (register a condition, notify when it fires) applied to three
// data sources, one registry instead of three bespoke ones. A Redis HASH per
// kind so a fired watcher can be removed by id in O(1), unlike a list.

const WATCHER_HASH_PREFIX = "watchers:"; // + kind

export type WatcherKind = "price" | "polymarket" | "onchain";

export interface PriceWatcherParams {
  symbol: string;
  targetPrice: number;
  direction: "above" | "below";
}

export interface PolymarketWatcherParams {
  slug: string;
  title: string;
  baselineVolume: number;
}

export interface OnchainWatcherParams {
  address: string;
  chainId: number;
  lastSeenTxHash: string | null;
}

export type WatcherParams = PriceWatcherParams | PolymarketWatcherParams | OnchainWatcherParams;

export interface Watcher {
  id: string;
  kind: WatcherKind;
  identity: string; // wallet or anonId — matches the push-subscription key in lib/notifications.ts
  params: WatcherParams;
  createdAt: number;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

export async function registerWatcher(
  kind: WatcherKind,
  identity: string,
  params: WatcherParams
): Promise<Watcher | null> {
  const redis = getRedis();
  if (!redis) return null;
  const watcher: Watcher = { id: randomId(), kind, identity, params, createdAt: Date.now() };
  await redis.hset(`${WATCHER_HASH_PREFIX}${kind}`, { [watcher.id]: JSON.stringify(watcher) });
  return watcher;
}

export async function listWatchers(kind: WatcherKind): Promise<Watcher[]> {
  const redis = getRedis();
  if (!redis) return [];
  const all = await redis.hgetall<Record<string, string>>(`${WATCHER_HASH_PREFIX}${kind}`);
  if (!all) return [];
  return Object.values(all)
    .map((raw) => {
      try { return JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as Watcher; }
      catch { return null; }
    })
    .filter((w): w is Watcher => w !== null);
}

export async function removeWatcher(kind: WatcherKind, id: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.hdel(`${WATCHER_HASH_PREFIX}${kind}`, id);
}
