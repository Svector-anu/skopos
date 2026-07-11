import { getAgentPayFetch, agentPaidEnabled } from "./x402Agent";

// Robinhood Chain launch feed, paid via x402 (docs/paid-data-sources.md). Skopos's
// own agent wallet fronts the $0.001/call — no user wallet, no signature. Reuses
// the same SKOPOS_X402_PRIVATE_KEY that pays Nansen (lib/smartMoneyServer.ts).
//
// No safety cross-check against lib/dexscreener.ts's scanToken here on purpose:
// DexScreener has not indexed Robinhood Chain (chainId 4663) as of 2026-07-11 —
// every lookup returns pairs:null, chain-brand-new tokens have no honeypot/
// liquidity signal to check yet regardless. The only real signal this feed itself
// provides is the creator's repeat-launch count — a wallet that's launched several
// tokens in the current feed window is a materially different risk than a first
// launch, so that's surfaced directly instead of a safety scan Skopos can't yet do
// on this chain. Revisit once DexScreener (or another aggregator) covers it.

const ENDPOINT = "https://robinhood-launches.hustlerhigher.workers.dev/recent-robinhood-launches";
const TIMEOUT_MS = 8_000;

export interface RobinhoodLaunch {
  symbol: string;
  name: string;
  address: string;
  ageMinutes: number;
  marketCapUsd: number;
  volume24hUsd: number;
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
  market: { marketCapUsd: number; volume24hUsd: number };
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await payFetch(`${ENDPOINT}?limit=${limit}&onlyAttributed=true`, { signal: controller.signal });
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
