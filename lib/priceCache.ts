const TIMEOUT_MS = 8_000;
const TTL_MS = 60_000;

export interface PriceResult {
  symbol: string;
  price: number;
  change24h: number | null;
  source: "coingecko" | "dexscreener";
}

interface CacheEntry {
  price: number;
  change24h: number | null;
  fetchedAt: number;
  source: "coingecko" | "dexscreener";
}

const priceCache = new Map<string, CacheEntry>();

// ── Full-name → ticker aliases (for natural-language queries like "solana price") ──
const SYMBOL_ALIASES: Record<string, string> = {
  SOLANA: "SOL",
  BITCOIN: "BTC",
  ETHEREUM: "ETH",
  BINANCE: "BNB",
  POLYGON: "MATIC",
  AVALANCHE: "AVAX",
  ARBITRUM: "ARB",
  OPTIMISM: "OP",
  CHAINLINK: "LINK",
  UNISWAP: "UNI",
  DOGECOIN: "DOGE",
  CARDANO: "ADA",
  POLKADOT: "DOT",
  RIPPLE: "XRP",
  TONCOIN: "TON",
  INJECTIVE: "INJ",
  CELESTIA: "TIA",
  COSMOS: "ATOM",
  FANTOM: "FTM",
  RENDER: "RENDER",
  APTOS: "APT",
  NOTCOIN: "NOT",
};

// ── CoinGecko symbol → ID map ─────────────────────────────────────────────────
// NOTE: matic-network is dead on CoinGecko — polygon-ecosystem-token is the correct ID for POL/MATIC
const CG_IDS: Record<string, string> = {
  ETH:  "ethereum",
  WETH: "weth",
  BTC:  "bitcoin",
  WBTC: "wrapped-bitcoin",
  SOL:  "solana",
  BNB:  "binancecoin",
  MATIC:"polygon-ecosystem-token",
  POL:  "polygon-ecosystem-token",
  AVAX: "avalanche-2",
  ARB:  "arbitrum",
  OP:   "optimism",
  LINK: "chainlink",
  UNI:  "uniswap",
  AAVE: "aave",
  MKR:  "maker",
  CRV:  "curve-dao-token",
  LDO:  "lido-dao",
  SNX:  "havven",
  COMP: "compound-governance-token",
  PEPE: "pepe",
  SHIB: "shiba-inu",
  DOGE: "dogecoin",
  XRP:  "ripple",
  ADA:  "cardano",
  DOT:  "polkadot",
  USDC: "usd-coin",
  USDT: "tether",
  DAI:  "dai",
  FRAX: "frax",
  XDAI: "xdai",
  MEGA: "megaeth",
  TRUMP:"official-trump",
  MELANIA:"melania-meme",
  WIF:  "dogwifcoin",
  BONK: "bonk",
  JUP:  "jupiter-exchange-solana",
  PYTH: "pyth-network",
  JTO:  "jito-governance-token",
  RENDER:"render-token",
  SUI:  "sui",
  APT:  "aptos",
  SEI:  "sei-network",
  TIA:  "celestia",
  INJ:  "injective-protocol",
  ATOM: "cosmos",
  NEAR: "near",
  FTM:  "fantom",
  TON:  "the-open-network",
  NOT:  "notcoin",
  HMSTR:"hamster-kombat",
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────

const BASE_HEADERS = {
  "Accept": "application/json",
  "User-Agent": "Mozilla/5.0 (compatible; Skopos/1.0)",
};

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal, next: { revalidate: 60 }, headers: BASE_HEADERS } as RequestInit);
  } finally {
    clearTimeout(timer);
  }
}

// ── CoinGecko (primary) ───────────────────────────────────────────────────────

async function fetchCoinGecko(
  ids: string[]
): Promise<Record<string, { price: number; change24h: number | null }>> {
  const result: Record<string, { price: number; change24h: number | null }> = {};
  if (ids.length === 0) return result;
  try {
    const res = await fetchWithTimeout(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd&include_24hr_change=true`
    );
    if (!res.ok) return result;
    const data = await res.json() as Record<string, { usd?: number; usd_24h_change?: number }>;
    for (const id of ids) {
      const entry = data[id];
      if (entry?.usd && entry.usd > 0) {
        result[id] = { price: entry.usd, change24h: entry.usd_24h_change ?? null };
      }
    }
  } catch {
    // network error — return partial
  }
  return result;
}

// ── DexScreener (fallback) ────────────────────────────────────────────────────

const STABLE_QUOTE_RE = /^(USDC|USDT|DAI|BUSD|USD|FDUSD|USDB|TUSD)$/i;

async function fetchDexScreener(
  symbol: string
): Promise<{ price: number; change24h: number | null } | null> {
  try {
    const res = await fetchWithTimeout(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(symbol)}`
    );
    if (!res.ok) return null;
    const data = await res.json() as { pairs?: Array<{
      baseToken: { symbol: string };
      quoteToken: { symbol: string };
      priceUsd?: string;
      priceChange?: { h24?: number };
      liquidity?: { usd?: number };
    }> };

    // Only use pairs quoted in a USD stablecoin — prevents staking pool prices
    // (e.g. SOL/mSOL showing $189 instead of the real USD price)
    const pairs = (data.pairs ?? [])
      .filter(p =>
        p.baseToken?.symbol?.toUpperCase() === symbol.toUpperCase() &&
        STABLE_QUOTE_RE.test(p.quoteToken?.symbol ?? "") &&
        p.priceUsd
      )
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));

    const top = pairs[0];
    if (!top?.priceUsd) return null;

    const price = parseFloat(top.priceUsd);
    if (!Number.isFinite(price) || price <= 0) return null;

    return { price, change24h: top.priceChange?.h24 ?? null };
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getPrices(
  symbols: string[]
): Promise<Record<string, PriceResult>> {
  const now = Date.now();
  const result: Record<string, PriceResult> = {};
  const toFetch: string[] = [];

  // 1. Serve from cache where fresh
  for (const sym of symbols) {
    const upper = SYMBOL_ALIASES[sym.toUpperCase()] ?? sym.toUpperCase();
    const cached = priceCache.get(upper);
    if (cached && now - cached.fetchedAt < TTL_MS) {
      result[upper] = { symbol: upper, price: cached.price, change24h: cached.change24h, source: cached.source };
    } else {
      toFetch.push(upper);
    }
  }

  if (toFetch.length === 0) return result;

  // 2. Batch CoinGecko call — group symbols that share a CoinGecko ID (e.g. MATIC + POL)
  const cgIdToSymbols: Record<string, string[]> = {};
  for (const sym of toFetch) {
    const id = CG_IDS[sym];
    if (id) {
      if (!cgIdToSymbols[id]) cgIdToSymbols[id] = [];
      cgIdToSymbols[id].push(sym);
    }
  }

  const cgIds = Object.keys(cgIdToSymbols);
  if (cgIds.length > 0) {
    const cgData = await fetchCoinGecko(cgIds);
    for (const [id, data] of Object.entries(cgData)) {
      for (const sym of cgIdToSymbols[id] ?? []) {
        const entry: CacheEntry = { ...data, fetchedAt: now, source: "coingecko" };
        priceCache.set(sym, entry);
        result[sym] = { symbol: sym, price: data.price, change24h: data.change24h, source: "coingecko" };
        console.log(`[price] ${sym}=$${data.price} source=coingecko`);
      }
    }
  }

  // 3. DexScreener fallback for any symbol still missing
  const missing = toFetch.filter(s => !result[s]);
  await Promise.all(
    missing.map(async (sym) => {
      const data = await fetchDexScreener(sym);
      if (data && data.price > 0) {
        const entry: CacheEntry = { ...data, fetchedAt: now, source: "dexscreener" };
        priceCache.set(sym, entry);
        result[sym] = { symbol: sym, price: data.price, change24h: data.change24h, source: "dexscreener" };
        console.log(`[price] ${sym}=$${data.price} source=dexscreener`);
      } else {
        console.warn(`[price] ${sym} - all sources failed`);
      }
    })
  );

  return result;
}

export async function getPrice(symbol: string): Promise<PriceResult | null> {
  const normalized = SYMBOL_ALIASES[symbol.toUpperCase()] ?? symbol.toUpperCase();
  const results = await getPrices([normalized]);
  return results[normalized] ?? null;
}

// ── 7-day chart + token metadata ─────────────────────────────────────────────

export interface PriceChartResult {
  sparkline: number[];
  name: string;
  image: string;
  circulatingSupply: number | null;
  maxSupply: number | null;
  marketCap: number | null;
  volume24h: number | null;
}

const chartCache = new Map<string, { data: PriceChartResult; fetchedAt: number }>();
const CHART_TTL_MS = 5 * 60 * 1000;

export async function getPriceChart(symbol: string): Promise<PriceChartResult | null> {
  const upper = symbol.toUpperCase();
  const cached = chartCache.get(upper);
  if (cached && Date.now() - cached.fetchedAt < CHART_TTL_MS) return cached.data;

  const cgId = CG_IDS[upper];
  if (!cgId) return null;

  try {
    const res = await fetchWithTimeout(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${cgId}&sparkline=true`
    );
    if (!res.ok) return null;
    const raw = await res.json() as Array<{
      name?: string;
      image?: string;
      market_cap?: number;
      total_volume?: number;
      circulating_supply?: number;
      max_supply?: number;
      sparkline_in_7d?: { price?: number[] };
    }>;
    const coin = raw[0];
    if (!coin) return null;
    const sparkline = coin.sparkline_in_7d?.price ?? [];
    if (sparkline.length === 0) return null;
    const data: PriceChartResult = {
      sparkline,
      name: coin.name ?? upper,
      image: coin.image ?? "",
      circulatingSupply: coin.circulating_supply ?? null,
      maxSupply: coin.max_supply ?? null,
      marketCap: coin.market_cap ?? null,
      volume24h: coin.total_volume ?? null,
    };
    chartCache.set(upper, { data, fetchedAt: Date.now() });
    return data;
  } catch {
    return null;
  }
}
