import { getAgentPayFetch, agentPaidEnabled } from "./x402Agent";

// Robinhood Chain launch feed, paid via x402 (docs/paid-data-sources.md). Skopos's
// own agent wallet fronts the $0.001/call — no user wallet, no signature. Reuses
// the same SKOPOS_X402_PRIVATE_KEY that pays Nansen (lib/smartMoneyServer.ts).
//
// DexScreener indexed Robinhood Chain as of 2026-07-12 (confirmed live — search
// for "robinhood" now returns real chainId:"robinhood" pairs), so the earlier
// "no aggregator covers this chain" caveat no longer holds at the chain level.
// Individual launches can still lag the index by minutes though (a token 1-2
// minutes old routinely comes back pairs:null even now) — that's normal
// DexScreener latency, not a Robinhood Chain gap, and this file still doesn't
// cross-check against lib/dexscreener.ts's scanToken per-launch (rate-limit
// risk of up to MAX_LIMIT parallel lookups per request, not yet worth it for a
// feed this fast-moving). Repeat-launch count remains the only safety signal
// surfaced here.

const ENDPOINT = "https://robinhood-launches.hustlerhigher.workers.dev/recent-robinhood-launches";
const TIMEOUT_MS = 8_000;
export const MAX_LIMIT = 25; // upstream API's own ceiling

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
