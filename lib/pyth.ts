const HERMES    = "https://hermes.pyth.network";
const TIMEOUT_MS = 8_000;
const TTL_MS     = 60_000;

const pythCache = new Map<string, { data: PythPrice; fetchedAt: number }>();

// Feed IDs verified live against Hermes API, May 2026.
// All FX/metal/equity feeds are quoted against USD.
export const PYTH_FEEDS = {
  // FX — direction matters for cross-rate math (see toUSDRate)
  "EUR/USD": "0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b",
  "GBP/USD": "0x84c2dde9633d93d1bcad84e7dc41c9d56578b7ec52fabedc1f335d673df0a7c1",
  "AUD/USD": "0x67a6f93030420c1c9e3fe37c1ab6b77966af82f995944a9fefce357a22854a80",
  "USD/JPY": "0xef2c98c804ba503c6a707e38be4dfbb16683775f195b091252bf24693042fd52",
  "USD/CHF": "0x0b1e3297e69f162877b577b0d6a47a0d63b2392bc8499e6540da4187a63e28f8",
  // Metals
  "XAU/USD": "0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2",
  "XAG/USD": "0xf2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e",
  // Equities — regular US-hours Pyth feeds (Equity.US.<TICKER>/USD), verified
  // against Hermes 2026-07-02. Stale after hours; check `stale` before surfacing.
  "AAPL":    "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
  "MSFT":    "0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1",
  "HOOD":    "0x306736a4035846ba15a3496eed57225b64cc19230a50d14f3ed20fd7219b7849",
  "NVDA":    "0xb1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
  "TSLA":    "0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
  "GOOGL":   "0x5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6",
  "META":    "0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe",
  "AMZN":    "0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a",
  "COIN":    "0xfee33f2a978bf32dd6b662b65ba8083c6773b494f8401194ec1870c640860245",
} as const;

export type PythFeedKey = keyof typeof PYTH_FEEDS;

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

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function getPythRates(
  keys: PythFeedKey[],
): Promise<Partial<Record<PythFeedKey, PythPrice>>> {
  if (keys.length === 0) return {};

  const now       = Date.now();
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

  const qs  = toFetch.map(k => `ids[]=${PYTH_FEEDS[k]}`).join("&");
  const url = `${HERMES}/v2/updates/price/latest?parsed=true&ignore_invalid_price_ids=true&${qs}`;

  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return result;

    const data = await res.json() as {
      parsed: Array<{ id: string; price: { price: string; expo: number; publish_time: number } }>;
    };

    const byId: Record<string, typeof data.parsed[0]> = {};
    for (const p of data.parsed) byId[p.id] = p;

    const nowSec = Math.floor(now / 1000);

    for (const key of toFetch) {
      const raw = byId[PYTH_FEEDS[key].slice(2)]; // strip 0x
      if (!raw) continue;
      const price = parseInt(raw.price.price) * Math.pow(10, raw.price.expo);
      const entry: PythPrice = {
        price,
        publishTime: raw.price.publish_time,
        stale:       nowSec - raw.price.publish_time > 14_400,
      };
      pythCache.set(key, { data: entry, fetchedAt: now });
      result[key] = entry;
    }

    return result;
  } catch {
    return result;
  }
}

export async function getPythRate(key: PythFeedKey): Promise<PythPrice | null> {
  const rates = await getPythRates([key]);
  return rates[key] ?? null;
}
