import { getAgentPayFetch, agentPaidEnabled } from "./x402Agent";
import { scanToken, type TokenRisk } from "./dexscreener";

// Robinhood Chain launch feed, paid via x402 (docs/paid-data-sources.md). Skopos's
// own agent wallet fronts the $0.001/call — no user wallet, no signature. Reuses
// the same SKOPOS_X402_PRIVATE_KEY that pays Nansen (lib/smartMoneyServer.ts).
//
// DexScreener indexed Robinhood Chain as of 2026-07-12 (confirmed live — search
// for "robinhood" now returns real chainId:"robinhood" pairs), so route.ts now
// cross-checks each *displayed* launch (top 5, not all MAX_LIMIT fetched) via
// scanRobinhoodLaunchRisk below — parallel (Promise.all in route.ts), and
// cached here with a short TTL so a hot token that keeps resurfacing across
// consecutive "what's launching" requests (likely, since the default sort
// re-ranks by volume/mcap ratio every time) doesn't re-hit DexScreener on
// every single one. Individual very-fresh launches can still come back
// unindexed (pairs:null) for a few minutes — that's normal DexScreener
// latency, not a Robinhood Chain gap.

const ENDPOINT = "https://robinhood-launches.hustlerhigher.workers.dev/recent-robinhood-launches";
const TIMEOUT_MS = 8_000;
export const MAX_LIMIT = 25; // upstream API's own ceiling

const RISK_CACHE_TTL_MS = 60_000;
const riskCache = new Map<string, { risk: TokenRisk | null; ts: number }>();

// Cached, failure-safe wrapper around scanToken for this feed specifically —
// deep-dive/risk-scan/the prebuy bundle all want scanToken's normal always-fresh
// behavior, so the cache lives here rather than inside scanToken itself.
export async function scanRobinhoodLaunchRisk(address: string): Promise<TokenRisk | null> {
  const key = address.toLowerCase();
  const cached = riskCache.get(key);
  if (cached && Date.now() - cached.ts < RISK_CACHE_TTL_MS) return cached.risk;
  const risk = await scanToken(address).catch(() => null);
  riskCache.set(key, { risk, ts: Date.now() });
  return risk;
}

export interface RobinhoodLaunch {
  symbol: string;
  name: string;
  address: string;
  ageMinutes: number;
  marketCapUsd: number;
  volume24hUsd: number;
  volume1hUsd: number;
  priceChange1hPct: number;
  transactions24h: number;
  creator: {
    xUsername: string | null;
    walletAddress: string;
    repeatLaunchCount: number;
    attributed: boolean;
  };
  bankrUrl: string;
  launchTweetUrl: string | null;
}

interface RawLaunch {
  token: { symbol: string; name: string; address: string };
  launch: { ageMinutes: number };
  market: {
    marketCapUsd: number;
    volume24hUsd: number;
    volume1hUsd?: number;
    priceChange1hPct?: number;
    transactions24h?: number;
  };
  creator: {
    xUsername: string | null;
    walletAddress: string;
    launchesInCurrentBankrFeed: number;
    bankrAttribution: boolean;
  };
  links: { bankr: string; launchTweet: string | null };
}

export function robinhoodFeedEnabled(): boolean {
  return agentPaidEnabled();
}

export async function getRecentRobinhoodLaunches(limit = 5): Promise<RobinhoodLaunch[] | null> {
  const payFetch = getAgentPayFetch();
  if (!payFetch) return null;

  const clampedLimit = Math.min(Math.max(limit, 1), MAX_LIMIT);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await payFetch(`${ENDPOINT}?limit=${clampedLimit}&onlyAttributed=true`, { signal: controller.signal });
    if (!res.ok) {
      console.error(`[robinhood-launches] ${res.status}`);
      return null;
    }
    const data = await res.json();
    const launches: RawLaunch[] = Array.isArray(data?.launches) ? data.launches : [];
    return launches.map((l) => ({
      symbol: l.token.symbol,
      name: l.token.name,
      address: l.token.address,
      ageMinutes: l.launch.ageMinutes,
      marketCapUsd: l.market.marketCapUsd,
      volume24hUsd: l.market.volume24hUsd,
      volume1hUsd: l.market.volume1hUsd ?? 0,
      priceChange1hPct: l.market.priceChange1hPct ?? 0,
      transactions24h: l.market.transactions24h ?? 0,
      creator: {
        xUsername: l.creator.xUsername,
        walletAddress: l.creator.walletAddress,
        repeatLaunchCount: l.creator.launchesInCurrentBankrFeed,
        attributed: l.creator.bankrAttribution,
      },
      bankrUrl: l.links.bankr,
      launchTweetUrl: l.links.launchTweet,
    }));
  } catch (err) {
    console.error("[robinhood-launches] threw:", err instanceof Error ? `${err.name}: ${err.message}` : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
