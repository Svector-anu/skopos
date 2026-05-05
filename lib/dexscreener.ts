const BASE = "https://api.dexscreener.com";
const TIMEOUT_MS = 8000;

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

export interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { symbol: string };
  priceUsd?: string;
  volume: { h24: number; h6: number; h1: number };
  priceChange: { h24: number; h6: number; h1: number };
  liquidity?: { usd: number };
  fdv?: number;
  marketCap?: number;
  txns?: { h24: { buys: number; sells: number } };
  pairCreatedAt?: number;
  url: string;
}

export interface TokenRisk {
  symbol: string;
  name: string;
  priceUsd: string | null;
  score: 1 | 2 | 3 | 4;        // 1=low, 2=medium, 3=high, 4=critical
  label: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  topPair: DexPair | null;
  totalLiquidityUsd: number;
  volume24h: number;
  marketCap: number | null;
  fdv: number | null;
  priceChange24h: number | null;
  pairCount: number;
  dexCount: number;
  flags: string[];
  sparkline?: number[];
}

const COINGECKO_IDS: Record<string, string> = {
  ETH: "ethereum", WETH: "weth", BTC: "bitcoin", WBTC: "wrapped-bitcoin",
  BNB: "binancecoin", MATIC: "polygon-ecosystem-token", POL: "polygon-ecosystem-token",
  AVAX: "avalanche-2", SOL: "solana", ARB: "arbitrum", OP: "optimism",
  LINK: "chainlink", UNI: "uniswap", AAVE: "aave", MKR: "maker",
  CRV: "curve-dao-token", LDO: "lido-dao", SNX: "havven", COMP: "compound-governance-token",
  PEPE: "pepe", SHIB: "shiba-inu", DOGE: "dogecoin", BCH: "bitcoin-cash",
  USDC: "usd-coin", USDT: "tether", DAI: "dai", FRAX: "frax",
  MEGA: "megaeth",
};

async function fetchSparkline(symbol: string): Promise<number[] | undefined> {
  const id = COINGECKO_IDS[symbol.toUpperCase()];
  if (!id) return undefined;
  try {
    const res = await fetchWithTimeout(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${id}&sparkline=true`
    );
    if (!res.ok) return undefined;
    const data = await res.json();
    return data?.[0]?.sparkline_in_7d?.price as number[] | undefined;
  } catch {
    return undefined;
  }
}

function scoreRisk(liquidityUsd: number, flags: string[]): 1 | 2 | 3 | 4 {
  if (liquidityUsd < 10_000 || flags.includes("NO_LIQUIDITY"))  return 4;
  if (liquidityUsd < 100_000 || flags.length >= 3)              return 3;
  if (liquidityUsd < 500_000 || flags.length >= 1)              return 2;
  return 1;
}

export async function scanToken(query: string): Promise<TokenRisk | null> {
  const isAddress = /^0x[0-9a-fA-F]{40}$/.test(query.trim());
  const url = isAddress
    ? `${BASE}/latest/dex/tokens/${query.trim()}`
    : `${BASE}/latest/dex/search?q=${encodeURIComponent(query.trim())}`;

  const res = await fetchWithTimeout(url);
  if (!res.ok) return null;

  const data = await res.json();
  const pairs: DexPair[] = data.pairs ?? [];
  if (pairs.length === 0) return null;

  // Use top pair by liquidity as primary reference
  const sorted = [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const top = sorted[0];

  const totalLiquidity = pairs.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0);
  const volume24h      = pairs.reduce((s, p) => s + (p.volume?.h24 ?? 0), 0);
  const marketCap      = top.marketCap ?? top.fdv ?? null;
  const dexes          = new Set(pairs.map(p => p.dexId));

  const flags: string[] = [];
  if (totalLiquidity < 10_000)                                  flags.push("NO_LIQUIDITY");
  if (volume24h > 0 && totalLiquidity > 0 && volume24h / totalLiquidity > 20) flags.push("VOLUME_SPIKE");
  if (pairs.length === 1 && dexes.size === 1)                   flags.push("SINGLE_POOL");
  if (top.pairCreatedAt && Date.now() - top.pairCreatedAt < 7 * 86400_000)   flags.push("NEW_TOKEN");
  if (top.priceChange?.h24 && Math.abs(top.priceChange.h24) > 50)            flags.push("HIGH_VOLATILITY");
  const buys  = top.txns?.h24?.buys  ?? 0;
  const sells = top.txns?.h24?.sells ?? 0;
  if (buys + sells > 0 && sells / (buys + sells) > 0.7)        flags.push("HEAVY_SELLING");

  const score = scoreRisk(totalLiquidity, flags);
  const LABELS = { 1: "LOW", 2: "MEDIUM", 3: "HIGH", 4: "CRITICAL" } as const;

  const sparkline = await fetchSparkline(top.baseToken.symbol);

  return {
    symbol:           top.baseToken.symbol,
    name:             top.baseToken.name,
    priceUsd:         top.priceUsd ?? null,
    score,
    label:            LABELS[score],
    topPair:          top,
    totalLiquidityUsd: totalLiquidity,
    volume24h,
    marketCap,
    fdv:              top.fdv ?? null,
    priceChange24h:   top.priceChange?.h24 ?? null,
    pairCount:        pairs.length,
    dexCount:         dexes.size,
    flags,
    sparkline,
  };
}
