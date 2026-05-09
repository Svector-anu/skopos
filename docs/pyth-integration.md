# Pyth Network Integration — Source of Truth

All facts in this doc are verified against the live Hermes API. Nothing is assumed from marketing pages.

---

## What Pyth Is (for Skopos)

A free, no-auth REST API that provides real-time prices for assets CoinGecko/DexScreener don't cover well:
- FX rates (EUR/USD, GBP/USD, JPY, etc.)
- Metals (gold, silver)
- Equities (AAPL, MSFT, etc.)
- Crypto (supplements existing CoinGecko stack)

Pyth does **not** replace the existing `priceCache.ts` (CoinGecko → DexScreener). It extends it.

---

## Hermes REST API

**Base URL:** `https://hermes.pyth.network`  
**Auth:** None required  
**Rate limits:** Not documented — use the existing `fetchWithTimeout` pattern (8s timeout)

### Endpoints

#### Get latest price(s)
```
GET /v2/updates/price/latest?ids[]=<feedId>&ids[]=<feedId>&parsed=true
```
- `ids[]` — one or more hex feed IDs (no `0x` prefix needed, but `0x` prefix works too)
- `parsed=true` — always include this; returns human-readable objects alongside the binary blob
- Returns up to **100 feeds in a single call**

**Response shape:**
```ts
{
  binary: { ... },        // ignore — for on-chain use
  parsed: [{
    id: string,           // 64-char hex
    price: {
      price: string,      // raw integer as string e.g. "233090000000"
      conf: string,       // confidence interval (same unit)
      expo: number,       // e.g. -8
      publish_time: number
    },
    ema_price: { price, conf, expo, publish_time },
    metadata: { slot, proof_available_time, prev_publish_time }
  }]
}
```

**Price calculation:**
```ts
const price = parseInt(parsed.price.price) * Math.pow(10, parsed.price.expo);
// e.g. "233090000000" * 10^-8 = $2330.90
```

**Staleness check:** Use `price.publish_time` (unix seconds). Do NOT use `metadata.proof_available_time` — that's the on-chain proof timestamp, not the oracle publish time.

```ts
const ageSeconds = Math.floor(Date.now() / 1000) - parsed.price.publish_time;
const isStale = ageSeconds > 60; // crypto; use 86400 for FX/metals on weekdays
```

**`ema_price`:** A smoothed exponential moving average of the price. Use `price` (not `ema_price`) for current price display.

**Always include `ignore_invalid_price_ids=true`** in batch requests — returns partial results for valid feeds instead of failing the whole call.

**Latency:** ~480–520ms per call (measured from macOS; Vercel edge will be similar).

#### Discover feed IDs
```
GET /v2/price_feeds?query=ETH&asset_type=crypto
```
- `query` — case-insensitive substring match on symbol/description
- `asset_type` — **must be lowercase**. Valid values (from API): `crypto`, `fx`, `metal`, `equity`, `rates`, `commodities`, `crypto_index`, `crypto_nav`, `crypto_redemption_rate`, `eco`, `kalshi`
- Returns array of `{ id, attributes: { symbol, base, description, asset_type, ... } }`
- When `query` contains `/` (e.g. `USD/CHF`), URL-encode it as `USD%2FCHF` or use `-G --data-urlencode` with curl

**Symbol format by asset type:**
- Crypto: `Crypto.ETH/USD`
- FX: `FX.EUR/USD`
- Metal: `Metal.XAU/USD`
- Equity: `Equity.US.AAPL/USD`

#### Historical price at timestamp
```
GET /v2/updates/price/{unix_timestamp}?ids[]=<feedId>&parsed=true
```
- Returns first available price update where `publish_time >= unix_timestamp`
- Data available from **April 2025 onward**
- Max 50 feeds per call

---

## What Does NOT Exist in the Free REST API

| Feature | Status | Notes |
|---|---|---|
| OHLC / candle data | ❌ Not in REST | MCP server only (`get_candlestick_data`) |
| Funding rates | ❌ Not in REST | No such asset type in Hermes |
| Streaming (SSE) | ✅ Exists | `/v2/updates/price/stream` — not needed for Skopos |

The Pyth MCP Skills docs mention "funding-rate asset type" — this is only valid inside the MCP server tool, not a real Hermes REST `asset_type` value. The actual Hermes asset types are the list above.

---

## Confirmed Feed IDs (verified live, May 2026)

### Crypto
| Symbol | Feed ID |
|---|---|
| ETH/USD | `0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace` |
| BTC/USD | `0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43` |
| SOL/USD | `0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d` |
| BNB/USD | `0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f` |
| AVAX/USD | `0x93da3352f9f1d105fdfe4971cfa80e9dd777bfc5d0f683ebb6e1294b92137bb7` |
| ARB/USD | `0x3fa4252848f9f0a1480be62745a4629d9eb1322aebab8a791e344b3b9c1adcf5` |
| OP/USD | `0x385f64d993f7b77d8182ed5003d97c60aa3361f3cecfe711544d2d59165e9bdf` |
| POL/USD (MATIC) | `0xffd11c5a1cfd42f80afb2df4d9f264c15f956d68153335374ec10722edd70472` |
| LINK/USD | `0x8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221` |
| USDC/USD | `0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a` |
| USDT/USD | `0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b` |
| WBTC/USD | `0xc9d8b075a5c69303365ae23633d4e085199bf5c520a3b90fed1322a0342ffc33` |
| STETH/USD | `0x846ae1bdb6300b817cee5fdee2a6da192775030db5615b94a465f53bd40850b5` |
| WSTETH/USD | `0x6df640f3b8963d8f8358f791f352b8364513f6ab1cca5ed3f1f7b5448980e784` |
| UNI/USD | `0x78d185a741d07edb3412b09008b7c5cfb9bbbd7d568bf00ba737b456ba171501` |
| AAVE/USD | `0x2b9ab1e972a281585084148ba1389800799bd4be63b957507db1349314e47445` |
| PEPE/USD | `0xd69731a2e74ac1ce884fc3890f7ee324b6deb66147055249568869ed700882e4` |

> Note: Polygon rebranded MATIC → POL. Pyth uses `Crypto.POL/USD`. Map both `MATIC` and `POL` to this feed ID.

### FX
| Pair | Feed ID |
|---|---|
| EUR/USD | `0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b` |
| GBP/USD | `0x84c2dde9633d93d1bcad84e7dc41c9d56578b7ec52fabedc1f335d673df0a7c1` |
| USD/JPY | `0xef2c98c804ba503c6a707e38be4dfbb16683775f195b091252bf24693042fd52` |
| USD/CHF | `0x0b1e3297e69f162877b577b0d6a47a0d63b2392bc8499e6540da4187a63e28f8` |
| AUD/USD | `0x67a6f93030420c1c9e3fe37c1ab6b77966af82f995944a9fefce357a22854a80` |

> FX rates are available as USD cross-pairs. For conversions like EUR→JPY, fetch EUR/USD and USD/JPY separately:
> ```
> EUR/JPY = (EUR/USD) × (USD/JPY)
> e.g.  1.1785 × 156.68 = 184.65 JPY per EUR
> ```
> **Not** `eurusd / usdjpy` — that gives 0.0075 which is wrong.

### Metals
| Asset | Feed ID |
|---|---|
| XAU/USD (Gold) | `0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2` |
| XAG/USD (Silver) | `0xf2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e` |

### Equities (US market hours only)
| Asset | Feed ID |
|---|---|
| AAPL/USD | `0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688` |
| MSFT/USD | `0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1` |

> Equity feeds return stale data outside US market hours (9:30am–4pm ET Mon–Fri). FX and metals are also stale on weekends. Check `price.publish_time` — if age > 15 minutes for equities, or age > 3600s for FX/metals outside trading hours, show "Markets closed — last price: $X" rather than treating as live.

---

## Integration Strategy for Skopos

### Data source ownership (never duplicate)

| Query type | Source | Reason |
|---|---|---|
| Crypto spot price (major) | CoinGecko (existing `priceCache.ts`) | Already works, 60s TTL, symbol names |
| Long-tail token price | DexScreener (existing `priceCache.ts`) | Better coverage, real DEX data |
| 7-day sparkline chart | CoinGecko (existing `priceCache.ts`) | Already works |
| **FX conversion** | **Pyth (new)** | CoinGecko doesn't have FX |
| **Gold / silver** | **Pyth (new)** | CoinGecko has poor metal coverage |
| **Equity prices** | **Pyth (new)** | CoinGecko doesn't have stocks |

### New intent categories (add to `classifyIntent()`)

```
"fx"     → e.g. "convert 1000 EUR to JPY", "what's GBP in USD"
"metal"  → e.g. "what's gold price", "how much is silver"
"equity" → e.g. "what's AAPL trading at"
```

These three are gaps today. Pyth fills them exactly.

### File to create: `lib/pyth.ts`

```ts
const HERMES = "https://hermes.pyth.network";

export const PYTH_FEEDS = {
  // Crypto
  ETH:    "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  BTC:    "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  SOL:    "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  // ... (full map from table above)

  // FX
  "EUR/USD": "0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b",
  "GBP/USD": "0x84c2dde9633d93d1bcad84e7dc41c9d56578b7ec52fabedc1f335d673df0a7c1",
  "USD/JPY": "0xef2c98c804ba503c6a707e38be4dfbb16683775f195b091252bf24693042fd52",

  // Metals
  XAU:    "0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2",
  XAG:    "0xf2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e",

  // Equities
  AAPL:   "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
  MSFT:   "0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1",
} as const;

export interface PythPrice {
  price: number;
  confidence: number;
  publishTime: number;   // unix seconds
  expo: number;
}

export async function getPythPrices(
  feedIds: string[]
): Promise<Record<string, PythPrice>> { ... }
```

---

## MCP Server (dev tool only)

**Endpoint:** `https://mcp.pyth.network/mcp`  
**Protocol:** MCP over HTTP (not a REST API — cannot be called with `fetch()`)

| Tool | Free | Notes |
|---|---|---|
| `get_symbols` | ✅ | Feed discovery |
| `get_candlestick_data` | ✅ | OHLC candles — not available in REST |
| `get_historical_price` | ✅ | From April 2025 |
| `get_latest_price` | ❌ | Requires Pyth Pro API key (paid) |

**Usage:** Add to Claude Code for development assistance only. Skopos's Next.js backend cannot call MCP servers directly.

```bash
claude mcp add pyth --transport http https://mcp.pyth.network/mcp
```

---

## Pyth Pro

Paid tier. Not required for Skopos's current scope. Would unlock:
- `get_latest_price` via MCP (redundant — Hermes REST gives this free)
- Higher rate limits
- SLA guarantees

Do not pursue until free tier becomes a bottleneck.
