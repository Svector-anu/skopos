const TIMEOUT_MS = 10_000;
const POOL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

let poolsCache: { data: YieldPool[]; fetchedAt: number } | null = null;

export interface YieldPool {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number;
  apyBase: number | null;
  apyReward: number | null;
  apyMean30d: number | null;
  rewardTokens: string[] | null;
  url?: string;
}

// Projects surfaced in the yield scanner
const FEATURED_PROJECTS = new Set([
  "aave-v3", "aave-v2",
  "morpho-blue", "morpho",
  "compound-v3", "compound-v2",
  "moonwell",
  "spark",
  "fluid",
  "yearn-finance",
  "curve-dex",
]);

const STABLES = new Set([
  "USDC", "USDT", "DAI", "FRAX", "LUSD", "GHO", "CRVUSD",
  "TUSD", "BUSD", "PYUSD", "MKUSD", "USDP", "GUSD", "SUSD",
  "3CRV", "FRAXBP",
]);

function isStablecoinPool(symbol: string): boolean {
  const tokens = symbol.split(/[-/+]/).map(t => t.trim().toUpperCase());
  return tokens.every(t => STABLES.has(t));
}

export async function getTopYields(symbol: string, limit = 10): Promise<YieldPool[]> {
  if (!poolsCache || Date.now() - poolsCache.fetchedAt > POOL_CACHE_TTL) {
    const res = await fetchWithTimeout("https://yields.llama.fi/pools");
    if (!res.ok) return [];
    const json: { data: YieldPool[] } = await res.json();
    poolsCache = { data: json.data, fetchedAt: Date.now() };
  }

  const { data } = poolsCache;

  return data
    .filter(p =>
      p.symbol.toUpperCase().includes(symbol.toUpperCase()) &&
      FEATURED_PROJECTS.has(p.project) &&
      p.apy > 0 &&
      p.tvlUsd > 100_000 &&
      (p.project !== "curve-dex" || isStablecoinPool(p.symbol))
    )
    .sort((a, b) => b.apy - a.apy)
    .slice(0, limit);
}
