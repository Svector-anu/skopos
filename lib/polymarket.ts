const BASE = "https://gamma-api.polymarket.com";
const TIMEOUT_MS = 8_000;

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

export interface PolymarketMarket {
  id: string;
  question: string;
  outcomes: string[];
  outcomePrices: string[];
  volume: number;
  endDate: string | null;
}

export interface PolymarketEvent {
  title: string;
  slug: string;
  volume: number;
  image: string | null;
  markets: PolymarketMarket[];
  url: string;
}

function parseJsonField<T>(value: unknown, fallback: T): T {
  if (Array.isArray(value)) return value as T;
  if (typeof value === "string") {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return fallback;
}

export async function getTopMarkets(keyword?: string, limit = 8): Promise<PolymarketEvent[]> {
  const fetchLimit = keyword ? 200 : Math.max(limit * 3, 30);
  const url = `${BASE}/events?active=true&closed=false&limit=${fetchLimit}&order=volume24hr&ascending=false`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) return [];

  const raw: Array<{
    title: string;
    slug: string;
    volume: number;
    image?: string;
    markets?: Array<{
      id: string;
      question: string;
      closed?: boolean;
      outcomes?: string | string[];
      outcomePrices?: string | string[];
      volume?: string | number;
      endDate?: string;
    }>;
  }> = await res.json();

  let events = raw
    .map(e => ({
      title: e.title,
      slug: e.slug,
      volume: e.volume ?? 0,
      image: e.image ?? null,
      url: `https://polymarket.com/event/${e.slug}`,
      // Only keep non-closed markets within each event
      markets: (e.markets ?? [])
        .filter(m => !m.closed)
        .map(m => ({
          id: m.id,
          question: m.question,
          outcomes:      parseJsonField<string[]>(m.outcomes,      ["Yes", "No"]),
          outcomePrices: parseJsonField<string[]>(m.outcomePrices, []),
          volume:        typeof m.volume === "string" ? parseFloat(m.volume) : (m.volume ?? 0),
          endDate:       m.endDate ?? null,
        })),
    }))
    .filter(e => e.markets.length > 0);

  if (keyword) {
    const ALIASES: Record<string, string[]> = {
      eth: ["eth", "ethereum"],
      btc: ["btc", "bitcoin"],
      sol: ["sol", "solana"],
      bnb: ["bnb", "binance"],
      xrp: ["xrp", "ripple"],
      ada: ["ada", "cardano"],
      avax: ["avax", "avalanche"],
      doge: ["doge", "dogecoin"],
      link: ["link", "chainlink"],
    };
    const kw = keyword.trim().toLowerCase();
    const terms = ALIASES[kw] ?? [kw];
    const pattern = new RegExp(terms.map(t => `\\b${t}\\b`).join("|"), "i");
    events = events.filter(
      e => pattern.test(e.title) || e.markets.some(m => pattern.test(m.question))
    );
  }

  return events.slice(0, limit);
}
