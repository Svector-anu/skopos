const TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

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
  "uniswap-v3",
  "spark",
  "fluid",
  "yearn-finance",
  "convex-finance",
  "curve-dex",
]);

export async function getTopYields(symbol: string, limit = 10): Promise<YieldPool[]> {
  const res = await fetchWithTimeout("https://yields.llama.fi/pools");
  if (!res.ok) return [];

  const { data }: { data: YieldPool[] } = await res.json();

  return data
    .filter(p =>
      p.symbol.toUpperCase().includes(symbol.toUpperCase()) &&
      FEATURED_PROJECTS.has(p.project) &&
      p.apy > 0 &&
      p.tvlUsd > 100_000
    )
    .sort((a, b) => b.apy - a.apy)
    .slice(0, limit);
}
