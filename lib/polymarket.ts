import { fetchWithTimeout } from "./http";

const BASE = "https://gamma-api.polymarket.com";

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

// Neutralizes regex metacharacters in text that came from a user. Kept local
// rather than pulled from a dependency — one line, and adding a package for it
// would be a larger supply-chain surface than the bug it fixes.
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    // Escaped: `keyword` is user text straight from the chat message (a
    // Polymarket topic like "trump 2028"), and it was interpolated into a
    // RegExp raw. Two consequences, both reachable from a normal message:
    // an unbalanced "(" or a reversed range like "[z-a]" throws a SyntaxError
    // at request time, and a crafted pattern turns a topic filter into an
    // attacker-supplied regex run against every market title we fetched.
    const pattern = new RegExp(terms.map(t => `\\b${escapeRegExp(t)}\\b`).join("|"), "i");
    events = events.filter(
      e => pattern.test(e.title) || e.markets.some(m => pattern.test(m.question))
    );
  }

  return events.slice(0, limit);
}
