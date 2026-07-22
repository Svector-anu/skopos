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
// Derived from Robinhood's own registry so the two can't drift: a hand-kept
// list had gone stale in both directions — it missed 14 tickers actually
// trading on the chain (PLTR, INTC, ORCL, MU, CRCL…) and carried 6 that have
// no token here at all. Detection stays symbol-based (an impersonator quote
// token still gets detected, then fails stockVerified below); the registry is
// only the source of which symbols count.
export const STOCK_PAIR_TICKERS: readonly string[] = Object.keys(RH_STOCK_TOKENS);

// Fee flywheel constants — based on standard Doppler launch parameters from
// Bankr's published docs (0.7% pool fee, 95% to the creator). Individual
// tokens may configure different tiers; every number derived from these is
// labeled an estimate. Verifying the real tier per pool: issue #86.
export const DOPPLER_FEE_RATE = 0.007;
export const DOPPLER_CREATOR_SHARE = 0.95;

export interface StockPairing {
  // The traded token's symbol as the pool reports it — authoritative when the
  // user queried by address, where the caller has no symbol to pass in.
  baseSymbol: string;
  stockSymbol: string;
  stockTokenAddress: string | null;
  // quoteToken.address matches Robinhood's own registry entry for this ticker
  // — a same-symbol impersonator pool fails this check.
  stockVerified: boolean;
  // The traded token itself is named after an equity ticker but is NOT that
  // ticker's registry token. Verification covers the quote side only, so
  // without this a "NVDA ⇄ TSLA · registry-verified" card reads as if the
  // impersonator were blessed.
  tokenImpersonatesTicker: boolean;
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
  return pairingFromPair(top, stockSymbol);
}

function pairingFromPair(top: DexPair, stockSymbol: string): StockPairing {
  const registryAddress = RH_STOCK_TOKENS[stockSymbol] ?? null;
  const quoteAddress = top.quoteToken.address ?? null;

  const baseSymbol = top.baseToken?.symbol?.toUpperCase() ?? "";
  const baseRegistryAddress = RH_STOCK_TOKENS[baseSymbol] ?? null;
  const tokenImpersonatesTicker =
    STOCK_PAIR_TICKERS.includes(baseSymbol) &&
    !(baseRegistryAddress && top.baseToken?.address &&
      baseRegistryAddress.toLowerCase() === top.baseToken.address.toLowerCase());

  return {
    baseSymbol,
    stockSymbol,
    stockTokenAddress: quoteAddress,
    stockVerified: !!(registryAddress && quoteAddress &&
      registryAddress.toLowerCase() === quoteAddress.toLowerCase()),
    tokenImpersonatesTicker,
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
  // Address queries pass the address itself as the symbol — the pool knows the
  // real one.
  const querySymbol = tokenSymbol.trim();
  const resolvedSymbol = /^0x[0-9a-f]{40}$/i.test(querySymbol)
    ? pairing.baseSymbol || querySymbol
    : querySymbol.toUpperCase();
  return { tokenSymbol: resolvedSymbol, tokenAddress, isEstimate: true, ...pairing, ...estimates };
}

// ─── Chain-wide discovery ─────────────────────────────────────────────────────
// Asking DexScreener for a stock token's pairs returns the pools that quote
// against it — i.e. the stock-paired tokens themselves. One call per registry
// ticker covers the chain, instead of the launch feed's 25-token / ~30-minute
// window, which structurally can't see anything that launched earlier (REAL
// and SKOPOS included).

const CHAIN_WIDE_TTL_MS = 5 * 60_000;
const DISCOVERY_CONCURRENCY = 6;
// DexScreener returns at most 30 pairs per token, liquidity-ranked, so a very
// busy stock token's thinnest pools can fall off the end. Deep pools — the
// ones worth surfacing — are unaffected.
const VERIFY_CANDIDATES = 18;

let chainWideCache: { at: number; items: StockPairedItem[] } | null = null;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

// Pairs quoting against one registry stock token, on Robinhood Chain, with the
// quote address matching the registry — an impersonator "NVDA" pool can't
// smuggle its tokens into the chain-wide list.
async function pairsQuotedAgainst(stockAddress: string): Promise<DexPair[]> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${BASE}/latest/dex/tokens/${stockAddress}`);
  } catch {
    return [];
  }
  if (!res.ok) return [];
  let data: { pairs?: DexPair[] };
  try {
    data = await res.json();
  } catch {
    return [];
  }
  return (data.pairs ?? []).filter(
    (p) =>
      p.chainId === ROBINHOOD_CHAIN_SLUG &&
      (p.quoteToken?.address ?? "").toLowerCase() === stockAddress.toLowerCase(),
  );
}

// Every stock-paired token on Robinhood Chain, liquidity-descending. Candidates
// come from the stock tokens' own pair lists; each survivor is then re-checked
// through buildStockPairedItem, which reads that token's *primary* pool — a
// token with a deep USDG pool and a shallow NVDA one is not stock-paired by the
// card's own definition, and gets dropped rather than shown with a headline it
// doesn't earn.
export async function findStockPairedTokens(limit = 12): Promise<StockPairedItem[]> {
  const cached = chainWideCache;
  if (cached && Date.now() - cached.at < CHAIN_WIDE_TTL_MS) {
    return cached.items.slice(0, limit);
  }

  const registry = Object.entries(RH_STOCK_TOKENS);
  const perStock = await mapWithConcurrency(registry, DISCOVERY_CONCURRENCY, ([, addr]) =>
    pairsQuotedAgainst(addr),
  );

  const bestByToken = new Map<string, DexPair>();
  for (const pair of perStock.flat()) {
    const key = pair.baseToken?.address?.toLowerCase();
    if (!key) continue;
    const existing = bestByToken.get(key);
    if (!existing || (pair.liquidity?.usd ?? 0) > (existing.liquidity?.usd ?? 0)) {
      bestByToken.set(key, pair);
    }
  }

  const candidates = [...bestByToken.values()]
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))
    .slice(0, VERIFY_CANDIDATES);

  const items = (
    await mapWithConcurrency(candidates, DISCOVERY_CONCURRENCY, (p) =>
      buildStockPairedItem(p.baseToken.symbol, p.baseToken.address),
    )
  )
    .filter((x): x is StockPairedItem => x !== null)
    .sort((a, b) => b.pairLiquidityUsd - a.pairLiquidityUsd);

  if (items.length > 0) chainWideCache = { at: Date.now(), items };
  return items.slice(0, limit);
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
