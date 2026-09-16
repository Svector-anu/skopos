import { fetchWithTimeout } from "./http";

// Pyth Hermes served FX, metals and equities here until 2026-09. It now
// answers every one of these feeds with:
//
//   403 Not entitled: no grant accepts this feed (asset type 'fx', ...)
//
// Auth is not the gate — licensing is. Any bearer token clears authentication
// and the request is then refused for lack of a commercial grant, and Pyth's
// status page reports all systems operational, so this is intended rather than
// an outage. No key we can obtain for free brings these back.
//
// Each asset class now comes from a keyless public source instead. The module
// path, exported names and return shapes are unchanged so the two callers
// (app/api/chat/route.ts, lib/stockPaired.ts) are untouched by the swap; the
// "Pyth" naming is now inaccurate and renaming it is a deliberate follow-up,
// kept out of an outage fix.
//
// Sources, all verified live 2026-09-16:
//   FX      open.er-api.com   one call returns every rate — cheaper than the
//                             per-feed batch this replaces
//   Metals  gold-api.com      spot XAU/XAG in USD
//   Equity  Yahoo chart API   unofficial. See EQUITY_SOURCE_RISK below.

const ERAPI  = "https://open.er-api.com/v6/latest/USD";
const METALS = "https://api.gold-api.com/price";
const YAHOO  = "https://query1.finance.yahoo.com/v8/finance/chart";

const TTL_MS = 60_000;
// Equities and metals stop ticking when their market closes; a price older
// than this is real but no longer live, and callers label it as such rather
// than hiding it.
const STALE_AFTER_SEC = 14_400;

const pythCache = new Map<string, { data: PythPrice; fetchedAt: number }>();

// EQUITY_SOURCE_RISK: Yahoo's chart endpoint is undocumented and unversioned.
// It is keyless and working today, but this project has now been broken twice
// by a vendor withdrawing a free tier (Groq 2026-08, Pyth 2026-09), so treat it
// as load-bearing-but-borrowed. The failure mode is contained: getEquity()
// returns null, the feed is simply absent from the result, and callers already
// handle a missing rate — `nvda price` says it cannot fetch, and the
// stock-paired card drops its USD leg while keeping the ratio. Nothing renders
// a wrong number.

// The supported feeds, mapped to the source that answers them. Still exported
// under the old name because lib/stockPaired.ts does a `symbol in PYTH_FEEDS`
// capability check, and the key set defines PythFeedKey.
export const PYTH_FEEDS = {
  // FX — direction is part of the key and drives the cross-rate math below
  "EUR/USD": "fx",
  "GBP/USD": "fx",
  "AUD/USD": "fx",
  "USD/JPY": "fx",
  "USD/CHF": "fx",
  // Metals
  "XAU/USD": "metal",
  "XAG/USD": "metal",
  // Equities
  "AAPL":  "equity",
  "MSFT":  "equity",
  "HOOD":  "equity",
  "NVDA":  "equity",
  "TSLA":  "equity",
  "GOOGL": "equity",
  "META":  "equity",
  "AMZN":  "equity",
  "COIN":  "equity",
  "SPY":   "equity",
  "QQQ":   "equity",
  "MSTR":  "equity",
  "AMD":   "equity",
  "PLTR":  "equity",
  "NFLX":  "equity",
  "MARA":  "equity",
  "RIOT":  "equity",
  "SOFI":  "equity",
  "PYPL":  "equity",
  "DIS":   "equity",
  "JPM":   "equity",
  "BABA":  "equity",
  "INTC":  "equity",
  "AVGO":  "equity",
  "UBER":  "equity",
  "CRM":   "equity",
  "ORCL":  "equity",
  "SMCI":  "equity",
  "ARKK":  "equity",
} as const;

export type PythFeedKey = keyof typeof PYTH_FEEDS;
type AssetClass = (typeof PYTH_FEEDS)[PythFeedKey];

export interface PythPrice {
  price:       number;
  publishTime: number;
  stale:       boolean;
}

// Returns USD-per-1-unit for any supported currency.
// EUR/USD: feed gives USD per EUR → return as-is.
// USD/JPY: feed gives JPY per USD → invert to get USD per JPY.
export function toUSDRate(currency: string, rates: Partial<Record<PythFeedKey, PythPrice>>): number {
  if (currency === "USD") return 1;
  const direct = rates[`${currency}/USD` as PythFeedKey];
  if (direct) return direct.price;
  const inverted = rates[`USD/${currency}` as PythFeedKey];
  if (inverted) return 1 / inverted.price;
  return NaN;
}

interface ErApiResponse {
  result: string;
  rates: Record<string, number>;
  time_last_update_unix: number;
  time_next_update_unix: number;
}

/**
 * Every fiat rate in one request, quoted as units-per-USD.
 *
 * These are daily reference rates, not live ticks — Pyth's were live. The
 * source publishes when its next update is due, so freshness is judged against
 * that rather than against the 4-hour market-close rule used for the classes
 * that do tick, which would mark a perfectly current daily rate stale.
 */
async function fetchFxRates(): Promise<{ rates: Record<string, number>; publishTime: number; stale: boolean } | null> {
  try {
    const res = await fetchWithTimeout(ERAPI);
    if (!res.ok) return null;
    const data = await res.json() as ErApiResponse;
    if (data.result !== "success" || !data.rates) return null;
    return {
      rates: data.rates,
      publishTime: data.time_last_update_unix,
      stale: Math.floor(Date.now() / 1000) > data.time_next_update_unix,
    };
  } catch {
    return null;
  }
}

async function fetchMetal(symbol: string): Promise<PythPrice | null> {
  try {
    const res = await fetchWithTimeout(`${METALS}/${symbol}`);
    if (!res.ok) return null;
    const data = await res.json() as { price?: number; updatedAt?: string };
    if (typeof data.price !== "number" || !(data.price > 0)) return null;
    const publishTime = data.updatedAt
      ? Math.floor(Date.parse(data.updatedAt) / 1000)
      : Math.floor(Date.now() / 1000);
    return {
      price: data.price,
      publishTime,
      stale: Math.floor(Date.now() / 1000) - publishTime > STALE_AFTER_SEC,
    };
  } catch {
    return null;
  }
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: { regularMarketPrice?: number; regularMarketTime?: number; currency?: string };
    }> | null;
  };
}

async function fetchEquity(ticker: string): Promise<PythPrice | null> {
  try {
    // Yahoo returns an empty body to requests without a browser UA.
    const res = await fetchWithTimeout(`${YAHOO}/${ticker}?interval=1d&range=1d`, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; Skopos/1.0)" },
    });
    if (!res.ok) return null;
    const data = await res.json() as YahooChartResponse;
    const meta = data.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    if (typeof price !== "number" || !(price > 0)) return null;
    // Guard against a non-USD listing being priced as if it were dollars.
    if (meta?.currency && meta.currency !== "USD") return null;
    const publishTime = meta?.regularMarketTime ?? Math.floor(Date.now() / 1000);
    return {
      price,
      publishTime,
      stale: Math.floor(Date.now() / 1000) - publishTime > STALE_AFTER_SEC,
    };
  } catch {
    return null;
  }
}

/**
 * Converts a units-per-USD table into the direction the feed key asks for.
 *
 * Exported for tests: inverting the wrong way is silent — a plausible number
 * in the wrong direction, off by the square of the rate — and it is the one
 * part of this module that cannot be spotted by reading the output.
 */
export function fxPriceFor(key: PythFeedKey, rates: Record<string, number>): number | null {
  const [base, quote] = key.split("/");
  if (base === "USD") {
    const perUsd = rates[quote];
    return typeof perUsd === "number" && perUsd > 0 ? perUsd : null;
  }
  const perUsd = rates[base];
  return typeof perUsd === "number" && perUsd > 0 ? 1 / perUsd : null;
}

export async function getPythRates(
  keys: PythFeedKey[],
): Promise<Partial<Record<PythFeedKey, PythPrice>>> {
  if (keys.length === 0) return {};

  const now = Date.now();
  const result: Partial<Record<PythFeedKey, PythPrice>> = {};
  const toFetch: PythFeedKey[] = [];

  for (const key of keys) {
    const cached = pythCache.get(key);
    if (cached && now - cached.fetchedAt < TTL_MS) {
      result[key] = cached.data;
    } else {
      toFetch.push(key);
    }
  }

  if (toFetch.length === 0) return result;

  const byClass = (cls: AssetClass) => toFetch.filter(k => PYTH_FEEDS[k] === cls);
  const fxKeys = byClass("fx");

  const record = (key: PythFeedKey, entry: PythPrice) => {
    pythCache.set(key, { data: entry, fetchedAt: now });
    result[key] = entry;
  };

  // One FX request covers every fiat key; metals and equities are per-symbol.
  // Settled together so a slow class never serialises behind another, and
  // allSettled so one dead source cannot empty the whole result — a partial
  // answer is the existing contract.
  const work: Promise<void>[] = [];

  if (fxKeys.length > 0) {
    work.push((async () => {
      const fx = await fetchFxRates();
      if (!fx) return;
      for (const key of fxKeys) {
        const price = fxPriceFor(key, fx.rates);
        if (price === null) continue;
        record(key, { price, publishTime: fx.publishTime, stale: fx.stale });
      }
    })());
  }

  for (const key of byClass("metal")) {
    work.push((async () => {
      const entry = await fetchMetal(key.split("/")[0]);
      if (entry) record(key, entry);
    })());
  }

  for (const key of byClass("equity")) {
    work.push((async () => {
      const entry = await fetchEquity(key);
      if (entry) record(key, entry);
    })());
  }

  await Promise.allSettled(work);
  return result;
}

export async function getPythRate(key: PythFeedKey): Promise<PythPrice | null> {
  const rates = await getPythRates([key]);
  return rates[key] ?? null;
}
