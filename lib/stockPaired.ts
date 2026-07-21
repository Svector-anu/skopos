import { fetchWithTimeout } from "./http";
import { getPythRate, PYTH_FEEDS, type PythFeedKey } from "./pyth";
import { RH_STOCK_TOKENS } from "./flash";
import type { DexPair } from "./dexscreener";

// Stock-paired token intelligence for Robinhood Chain (4663): tokens whose
// liquidity pool quotes against a tokenized stock (REAL/NVDA) instead of
// USDG/WETH. Detection reads pool data — the quote side of the
// highest-liquidity pair — never a hardcoded token address. The one address
// map consulted (RH_STOCK_TOKENS) comes from Robinhood's own registry and is
// used to VERIFY a detected pairing (impersonation check), not to detect it.

const BASE = "https://api.dexscreener.com";
const ROBINHOOD_CHAIN_SLUG = "robinhood";

// Equity tickers that count as a stock pairing when seen on the quote side.
// Symbols, deliberately not addresses — easy to extend as Robinhood Chain
// lists more stocks. Detection is symbol-based; address verification against
// Robinhood's registry happens separately (stockVerified below).
export const STOCK_PAIR_TICKERS: readonly string[] = [
  "NVDA", "TSLA", "AAPL", "MSFT", "GOOGL", "AMZN", "META",
  "SPY", "QQQ", "AMD", "COIN", "NFLX", "GME", "JPM", "MA", "BAC", "XOM",
];

// Fee flywheel constants — based on standard Doppler launch parameters from
// Bankr's published docs (0.7% pool fee, 95% to the creator). Individual
// tokens may configure different tiers; every number derived from these is
// labeled an estimate. Verifying the real tier per pool: issue #86.
export const DOPPLER_FEE_RATE = 0.007;
export const DOPPLER_CREATOR_SHARE = 0.95;

export interface StockPairing {
  stockSymbol: string;
  stockTokenAddress: string | null;
  // quoteToken.address matches Robinhood's own registry entry for this ticker
  // — a same-symbol impersonator pool fails this check.
  stockVerified: boolean;
  priceInStockTerms: string | null; // DexScreener priceNative — token priced in stock units
  tokenPriceUsd: string | null;
  pairAddress: string;
  pairLiquidityUsd: number;
  pairVolume24hUsd: number;
  pairCreatedAt: number | null;
  pairUrl: string;
}

export interface StockPairedEstimates {
  stockPriceUsd: number | null;
  stockPriceStale: boolean;
  dailyStockValueEstimate: number | null;  // USD/day accruing to the creator
  dailyStockTokensEstimate: number | null; // stock tokens/day at current stock price
  totalAccumulatedEstimate: number | null; // USD since launch — rough
  daysOld: number | null;
}

export interface StockPairedItem extends StockPairing, StockPairedEstimates {
  tokenSymbol: string;
  tokenAddress: string;
  isEstimate: true;
}

// All pairs for a token address on Robinhood Chain, liquidity-descending.
export async function getRobinhoodPairs(tokenAddress: string): Promise<DexPair[]> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${BASE}/latest/dex/tokens/${tokenAddress}`);
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const data = await res.json();
  const pairs: DexPair[] = data.pairs ?? [];
  return pairs
    .filter((p) => p.chainId === ROBINHOOD_CHAIN_SLUG)
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
}

// Highest-liquidity pair decides the pairing (known gap under adversarial
// liquidity: issue #90). Returns null when that pair quotes against a
// non-equity asset (USDG/WETH/etc.) — a standard pool, not stock-paired.
export function detectStockPairing(pairs: DexPair[]): StockPairing | null {
  const top = pairs[0];
  if (!top?.quoteToken?.symbol) return null;
  const stockSymbol = top.quoteToken.symbol.toUpperCase();
  if (!STOCK_PAIR_TICKERS.includes(stockSymbol)) return null;

  const registryAddress = RH_STOCK_TOKENS[stockSymbol] ?? null;
  const quoteAddress = top.quoteToken.address ?? null;
  return {
    stockSymbol,
    stockTokenAddress: quoteAddress,
    stockVerified: !!(registryAddress && quoteAddress &&
      registryAddress.toLowerCase() === quoteAddress.toLowerCase()),
    priceInStockTerms: top.priceNative ?? null,
    tokenPriceUsd: top.priceUsd ?? null,
    pairAddress: top.pairAddress,
    pairLiquidityUsd: top.liquidity?.usd ?? 0,
    pairVolume24hUsd: top.volume?.h24 ?? 0,
    pairCreatedAt: top.pairCreatedAt ?? null,
    pairUrl: top.url,
  };
}

// USD-derived estimates need the stock's Pyth price; when the ticker has no
// feed (issue #88) the pairing still surfaces — estimates just stay null.
export async function buildEstimates(pairing: StockPairing): Promise<StockPairedEstimates> {
  const hasFeed = pairing.stockSymbol in PYTH_FEEDS;
  const rate = hasFeed ? await getPythRate(pairing.stockSymbol as PythFeedKey) : null;
  const stockPriceUsd = rate && rate.price > 0 ? rate.price : null;

  const daysOld = pairing.pairCreatedAt
    ? Math.max(0, (Date.now() - pairing.pairCreatedAt) / 86_400_000)
    : null;
  const dailyStockValueEstimate =
    pairing.pairVolume24hUsd > 0
      ? pairing.pairVolume24hUsd * DOPPLER_FEE_RATE * DOPPLER_CREATOR_SHARE
      : null;

  return {
    stockPriceUsd,
    stockPriceStale: rate?.stale ?? false,
    dailyStockValueEstimate,
    dailyStockTokensEstimate:
      dailyStockValueEstimate !== null && stockPriceUsd !== null
        ? dailyStockValueEstimate / stockPriceUsd
        : null,
    totalAccumulatedEstimate:
      dailyStockValueEstimate !== null && daysOld !== null
        ? dailyStockValueEstimate * daysOld
        : null,
    daysOld,
  };
}

export async function buildStockPairedItem(
  tokenSymbol: string,
  tokenAddress: string,
): Promise<StockPairedItem | null> {
  const pairs = await getRobinhoodPairs(tokenAddress);
  const pairing = detectStockPairing(pairs);
  if (!pairing) return null;
  const estimates = await buildEstimates(pairing);
  return { tokenSymbol: tokenSymbol.toUpperCase(), tokenAddress, isEstimate: true, ...pairing, ...estimates };
}

// Cheap detection off an already-fetched top pair (scanToken's topPair) — used
// by the research/risk paths to decide whether the full item is worth building,
// without a second DexScreener round-trip for non-stock-paired tokens.
export function topPairLooksStockPaired(topPair: DexPair | null | undefined): boolean {
  return !!(
    topPair &&
    topPair.chainId === ROBINHOOD_CHAIN_SLUG &&
    topPair.quoteToken?.symbol &&
    STOCK_PAIR_TICKERS.includes(topPair.quoteToken.symbol.toUpperCase())
  );
}
