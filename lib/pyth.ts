import { fetchWithTimeout } from "./http";

const HERMES    = "https://hermes.pyth.network";
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
  "SPY":     "0x19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5",
  "QQQ":     "0x9695e2b96ea7b3859da9ed25b7a46a920a776e2fdae19a7bcfdf2b219230452d",
  "MSTR":    "0xe1e80251e5f5184f2195008382538e847fafc36f751896889dd3d1b1f6111f09",
  "AMD":     "0x3622e381dbca2efd1859253763b1adc63f7f9abb8e76da1aa8e638a57ccde93e",
  "PLTR":    "0x11a70634863ddffb71f2b11f2cff29f73f3db8f6d0b78c49f2b5f4ad36e885f0",
  "NFLX":    "0x8376cfd7ca8bcdf372ced05307b24dced1f15b1afafdeff715664598f15a3dd2",
  "MARA":    "0x0fc2ad77a9ab75bcbc3ebd7a9ff60facd08c517309e2d684baa979c910a0e43e",
  "RIOT":    "0x46417522a59b245c5af35c33c13426d991b36514c4c85aaefe1cf787e7daad90",
  "SOFI":    "0x72fae0e0683c186f5ce9444afac9909cf5d60b499f4f9569dd75442f19c625c8",
  "PYPL":    "0x773c3b11f6be58e8151966a9f5832696d8cd08884ccc43ac8965a7ebea911533",
  "DIS":     "0x703e36203020ae6761e6298975764e266fb869210db9b35dd4e4225fa68217d0",
  "JPM":     "0x7f4f157e57bfcccd934c566df536f34933e74338fe241a5425ce561acdab164e",
  "BABA":    "0x72bc23b1d0afb1f8edef20b7fb60982298993161bc0fd749587d6f60cd1ee9a3",
  "INTC":    "0xc1751e085ee292b8b3b9dd122a135614485a201c35dfc653553f0e28c1baf3ff",
  "AVGO":    "0xd0c9aef79b28308b256db7742a0a9b08aaa5009db67a52ea7fa30ed6853f243b",
  "UBER":    "0xc04665f62a0eabf427a834bb5da5f27773ef7422e462d40c7468ef3e4d39d8f1",
  "CRM":     "0xfeff234600320f4d6bb5a01d02570a9725c1e424977f2b823f7231e6857bdae8",
  "ORCL":    "0xe47ff732eaeb6b4163902bdee61572659ddf326511917b1423bae93fcdf3153c",
  "SMCI":    "0x8f34132a42f8bb7a47568d77a910f97174a30719e16904e9f2915d5b2c6c2d52",
  "ARKK":    "0xb2fe0af6c828efefda3ffda664f919825a535aa28a0f19fc238945c7aff540b1",
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
