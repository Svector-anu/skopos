# Skopos — System Architecture & Source of Truth

**Last verified:** 2026-05-05  
**State:** Production (Vercel). All caches are in-memory, reset on cold starts.

---

## 1. What Skopos Is

Skopos is an **orchestration layer**. It does not own any execution infrastructure. It:

1. Classifies user intent from natural language
2. Routes to the correct tool (Delora, Polymarket, DeFiLlama, Alchemy)
3. Returns structured data or calldata to the frontend
4. Never executes transactions — all signing happens client-side in the browser

The backend is a single Next.js API route: `POST /api/chat` (`app/api/chat/route.ts`).

---

## 2. System Boundaries

```
User input (browser)
    ↓
Privy Auth (EVM + Solana wallet identity)
    ↓
POST /api/chat  { message, senderAddress, solanaAddress, history, slippage }
    ↓
classifyIntent() → route to one engine
    ↓
┌──────────────────────────────────────────────────────┐
│  Delora        Polymarket       Yield       Analysis  │
│  (execute)     (read+deposit)   (scan)      (explain) │
└──────────────────────────────────────────────────────┘
    ↓
JSON response → frontend renders UI, user signs tx
```

---

## 3. Routing Layer

### Entry: `classifyIntent()` — `lib/parseIntent.ts`

Returns one of: `"price" | "execution" | "analysis" | "informational" | "yield" | "prediction" | "unknown"`

**Priority order (top wins):**
1. `hasExecVerb && hasAmount` → `"execution"`
2. `hasPriceKeyword && hasKnownToken` → `"price"`
3. `hasOpinionSignal` → `"informational"` (overrides token-only fallback)
4. `hasYieldKeyword` → `"yield"`
5. `hasPredictionKeyword` → `"prediction"`
6. analysis regex → `"analysis"`
7. informational regex → `"informational"`
8. `hasKnownToken && !execVerb && !amount && !opinion && !yield` → `"price"` (bare token fallback)
9. → `"unknown"`

**Critical guards:**
- "should i buy eth" → opinion signal fires → `"informational"` (NOT price)
- "best yield on usdc" → yield keyword fires → `"yield"` (NOT price)
- "swap 1 eth to usdc" → execVerb + amount → `"execution"` (no LLM)

### Route Waterfall in `route.ts`

The full dispatch sequence (each block returns early if it matches):

| Step | Condition | Handler |
|------|-----------|---------|
| 1 | Rate limit | 429 error |
| 2 | `queryType === "price"` | `getPrice()` → CoinGecko → DexScreener |
| 3 | ENS name (`*.eth`) | `resolveENS()` → `lookupAddress()` |
| 4 | Embedded 0x40 in sentence | `lookupAddress()` |
| 5 | Portfolio keyword | `lookupAddress(senderAddress)` |
| 6 | TX hash (0x64) | `lookupTx()` |
| 7 | Address only (0x40) | `lookupAddress()` |
| 8 | Multi-leg rebalance | `parseRebalanceIntent()` → N × `resolveLeg()` |
| 9 | Missing source chain | Static error |
| 10 | Meta-question | Static "I'm here to help with DeFi" |
| 11 | Polymarket balance | `getPolymarketBalance(senderAddress)` |
| 12 | Deposit status (0x40 + deposit keyword) | `getDepositStatus(address)` |
| 13 | Bet intent (BET_RE) | `getTopMarkets()` + `generateDepositAddress()` |
| 14 | Polymarket view (polyKeyword regex) | `getTopMarkets()` |
| 15 | `queryType === "prediction"` (safety net) | `getTopMarkets()` |
| 16 | `queryType === "informational"` | `getGroqInformationalReply()` |
| 17 | Single-leg: `parseIntent()` succeeds | `resolveLeg()` → quote calldata |
| 18 | Token risk (`scan/risk/safe/rug`) | `scanToken()` |
| 19 | Yield with token | `getTopYields(symbol)` |
| 20 | `queryType === "yield"` without token | Static "which token?" |
| 21 | `queryType === "execution" / "unknown"` + suggestions | Static + `buildSuggestions()` |
| 22 | Catch-all | `getGroqInformationalReply()` (constrained, no live data) |

**Rule: LLM is never called when a tool can answer.** LLM is only at steps 16 and 22.

---

## 4. Execution Engines

### 4A. Delora — Swaps & Bridges

**API:** `https://api.delora.build`  
**Auth:** `x-api-key: DELORA_API_KEY` header  
**Integrator tag:** `ANU`, fee: `0.05%`

**Supported chains:** 25+ EVM chains + Solana (Delora internal ID: 1000000001)  
See `lib/chains.ts` for full alias map.

**Flow:**
```
user: "swap 1 ETH to USDC on base"
    ↓
classifyIntent → "execution"
    ↓
parseIntent (regex → Groq fallback)
    ↓
resolveLeg():
  1. resolveChainId()     — map chain name → chain ID
  2. getChainById()       — fetch chain metadata from Delora (native token, decimals)
  3. getToken()           — resolve token contract address from Delora /v1/tokens
  4. toWei()             — convert human amount to wei
  5. getQuote()          — GET /v1/quotes (returns calldata + fees)
    ↓
return { type: "quote", intent, route, approval, calldata }
    ↓
frontend: user approves ERC-20 (if needed) → wagmi sendTransaction(calldata)
```

**Caches (in-memory, reset on cold start):**
- Chains: 10 min TTL
- Tokens: 10 min TTL

**Key constraints:**
- Both `senderAddress` and `receiverAddress` are required
- Same-chain + same-token = guard fires (no-op route)
- EVM→Solana: requires Phantom `solanaAddress` in request
- Solana→EVM: requires Phantom `solanaAddress` as effective sender

**Solana ID:** `1000000001` (Delora's internal chain ID, not standard)

---

### 4B. Polymarket — Prediction Markets

**Status: V1 — Read-only + deposit generation. No order execution.**

#### Data sources:
| API | URL | Auth | Use |
|-----|-----|------|-----|
| Gamma API | `https://gamma-api.polymarket.com` | None | Events, markets, odds, volume |
| Bridge API | `https://bridge.polymarket.com` | None | Deposit address generation, deposit status |
| Alchemy Polygon RPC | `polygon-mainnet.g.alchemy.com/v2/${KEY}` | ALCHEMY_API_KEY | pUSD balance check (eth_call) |

#### pUSD token (Polygon):
- Contract: `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`  
- Decimals: 6  
- Verified against PolygonScan ("Polymarket: pUSD Token") and `docs.polymarket.com`

#### pUSD balance check:

```
eth_call → to: PUSD_ADDRESS, data: 0x70a08231 + address.padStart(64)
result → Number(BigInt(result)) / 10^6
```

#### Deposit flow:
```
user: "bet $50 on bitcoin" OR "deposit to polymarket"
    ↓
generateDepositAddress(senderAddress) → POST bridge.polymarket.com/deposit
    ↓
returns { evm: "0x...", svm: "...", btc: "..." }
    ↓
user sends funds to deposit address (from any chain, any token)
bridge auto-swaps to pUSD on Polygon
    ↓
user asks: "did my deposit land?"
    ↓
getPolymarketBalance(senderAddress) → Alchemy Polygon eth_call → returns balance
```

#### V1 capabilities:
- ✅ Show top markets + odds
- ✅ Filter markets by keyword/topic
- ✅ Generate deposit address (EVM/SOL/BTC)
- ✅ Check pUSD on-chain balance by connected wallet
- ✅ Check deposit status by deposit address

#### V1 blockers (not implemented):
- ❌ Place orders — requires EIP-712 L1 signing (private key needed server-side, unacceptable)
- ❌ Redeem winnings — same blocker
- ❌ Manage positions

**V2 path:** Wallet-side EIP-712 signing via Privy connected wallet. No server-side key needed. Not yet designed.

---

### 4C. Yield — DeFiLlama

**Source:** `https://yields.llama.fi/pools`  
**Cache:** 5 min in-memory

**Filter criteria:**
- Symbol matches query token
- Project in allowlist: `aave-v3, aave-v2, morpho-blue, morpho, compound-v3, compound-v2, moonwell, spark, fluid, yearn-finance, curve-dex`
- `apy > 0`
- `tvlUsd > $100,000`
- Curve: only stablecoin pools (no volatile pairs)

**Result:** Top 10 pools by APY for the requested symbol.

**Supported query tokens:** USDC, ETH, WBTC, DAI, USDT, WETH, CBBTC, GHO, LUSD, FRAX, CRVUSD

---

### 4D. Analysis / Explanation — Groq LLM

**Model:** `openai/gpt-oss-20b` (was `llama-3.1-8b-instant`, decommissioned by Groq 2026-08-16)  
**System prompt:** `GROQ_INFORMATIONAL_SYSTEM` (constrained)

**Strict rules enforced in system prompt:**
- No live prices, APYs, TVLs, or time-sensitive numbers
- No transaction suggestions
- Max 3 sentences unless listing
- No hallucination — "I don't have reliable information" if unsure

**Post-processing:** `redactLiveNumbers()` strips any `$X,XXX` or `X% APY` patterns that slip through.

**Two call sites:**
1. `queryType === "informational"` — direct explanation query
2. Catch-all fallback — anything that didn't match a tool

**Intentionally excluded from:** price queries, yield queries, execution quotes, Polymarket data.

---

## 5. Data Sources Reference

| Source | URL | Auth | TTL | Fallback |
|--------|-----|------|-----|----------|
| Delora | `api.delora.build` | DELORA_API_KEY | 10 min (chains+tokens) | Error returned |
| CoinGecko | `api.coingecko.com` | None (free tier) | 60 s (in-memory) | DexScreener |
| DexScreener | `api.dexscreener.com` | None | None | — (best-effort) |
| Alchemy (EVM) | `*.g.alchemy.com/v2/${KEY}` | ALCHEMY_API_KEY | None | Ankr (BSC/Avax/Gnosis) |
| Ankr | `rpc.ankr.com/multichain` | None | None | Skip chain |
| Polymarket Gamma | `gamma-api.polymarket.com` | None | None | Empty array |
| Polymarket Bridge | `bridge.polymarket.com` | None | None | null |
| DeFiLlama | `yields.llama.fi/pools` | None | 5 min (in-memory) | Empty array |
| Groq | (SDK) | GROQ_API_KEY | None | Fallback string |

**Alchemy chains with ERC-20 support:** Ethereum (1), Base (8453), Arbitrum (42161), Optimism (10), Polygon (137), zkSync (324), Linea (59144)  
**Non-Alchemy (Ankr fallback):** BSC (56), Avalanche (43114), Gnosis (100)

---

## 6. Wallet & Auth Layer

**Library:** Privy (`@privy-io/react-auth` v3.21.2)  
**EVM wallet:** Privy embedded + external wallets via wagmi  
**Solana wallet:** Phantom via `@solana/wallet-adapter-react`

**What gets sent to the API on every request:**
```typescript
{
  message: string,
  senderAddress: string | null,   // EVM 0x address (Privy)
  solanaAddress: string | null,   // base58 Solana pubkey (Phantom)
  history: ConversationTurn[],    // last 4 messages for LLM context
  slippage: number,               // 0.003–0.01, default 0.005
}
```

**Transaction execution (client-side only):**
- ERC-20 approve → `useWriteContract`
- Bridge/swap → `useSendTransaction` with calldata from Delora quote
- Solana → `useWallet().sendTransaction()` from `@solana/wallet-adapter-react`

**No server-side key storage. No custody. Server only produces calldata.**

---

## 7. Frontend Response Handling

The frontend (`app/app/page.tsx`) handles two response shapes:

| Content-Type | Shape | Handler |
|---|---|---|
| `application/json` | `{ type: "quote" \| "text" \| "error" \| "rebalance" \| "tx" \| "address" \| "token_risk" \| "yield_pools" \| "polymarket" \| "suggestions" }` | Parse JSON, render typed component |
| `text/plain` | Streaming text | Drip-reader, word-by-word typewriter |

**Note:** As of 2026-05-05, the streaming path (`text/plain`) is no longer produced by the API. The catch-all now returns JSON. The streaming handler code still exists in the frontend but is not triggered.

---

## 8. Known Risks & Open Questions

### ⚠ Structural
1. **In-memory caches on Vercel** — Chains, tokens, yield pools, and price cache are all in-memory Maps/variables. Vercel serverless functions are stateless — each cold start resets these. Under load, multiple instances run in parallel with separate caches. No shared cache layer (no Redis/KV).

3. **Rate limit is per-process** — The 30 req/min limit is an in-memory sliding window per serverless instance. On Vercel with multiple concurrent instances, effective rate limit is `30 × N instances`.

4. **No server-side wallet verification** — `senderAddress` in the POST body is trusted. Any client can claim any address. For read-only operations (portfolio lookup, balance check) this exposes data but causes no financial risk. For quote generation, calldata is keyed to the claimed address, so mismatched addresses will produce unusable quotes.

5. **Anthropic SDK present but unused** — `@anthropic-ai/sdk` is in `package.json` but not imported anywhere in the current codebase. Either planned feature or dead dependency.

6. **Polymarket Groq fallback order** — The `queryType === "prediction"` safety handler at step 15 calls `getTopMarkets(undefined, 5)` — no keyword, top 5 by volume. This is intentional: if classifyIntent detects "prediction" but no specific keyword matched earlier regexes, show the top markets as default.

### ℹ Intentional limitations
7. **Polymarket CLOB not implemented** — Placing, cancelling, or managing orders requires server-side EIP-712 signing with a user's private key. This is a design constraint, not a bug. V2 path: wallet-side signing via Privy.

8. **DeFiLlama is curated** — `FEATURED_PROJECTS` allowlist excludes newer/smaller protocols intentionally to avoid showing low-TVL or risky pools.

9. **CoinGecko free tier** — No API key. Subject to rate limiting. DexScreener is the fallback for symbols without a CoinGecko ID.

---

## 9. Environment Variables Required

| Variable | Used by | Required |
|----------|---------|----------|
| `DELORA_API_KEY` | `lib/delora.ts` | Yes |
| `DELORA_INTEGRATOR` | `lib/delora.ts` | No (defaults to "ANU") |
| `ALCHEMY_API_KEY` | `lib/alchemy.ts`, `lib/polymarket-bridge.ts` | Yes |
| `GROQ_API_KEY` | `lib/parseIntent.ts` | Yes (LLM features degrade gracefully without it) |
| `NEXT_PUBLIC_PRIVY_APP_ID` | Privy SDK | Yes |

---

## 10. File Map

```
app/api/chat/route.ts         — Main dispatch logic (the "brain")
lib/parseIntent.ts            — classifyIntent(), parseIntent(), Groq wrappers
lib/delora.ts                 — Delora API (chains, tokens, quotes)
lib/chains.ts                 — Chain alias map (name → chain ID), toWei()
lib/polymarket.ts             — Gamma API (market events, odds)
lib/polymarket-bridge.ts      — Bridge API (deposit address, deposit status, pUSD balance)
lib/defillama.ts              — DeFiLlama (yield pools)
lib/alchemy.ts                — Alchemy (portfolio, tx lookup, ENS, ERC-20 balances)
lib/alchemy-types.ts          — TypeScript types for Alchemy data
lib/dexscreener.ts            — DexScreener (token risk scan, price fallback)
lib/priceCache.ts             — Price cache (CoinGecko primary, DexScreener fallback)
lib/wagmi.ts                  — wagmi config (25 chains, public RPC URLs)
lib/commands.ts               — Landing page demo commands (static, UI only)
app/app/page.tsx              — Main chat UI, wallet hooks, tx execution
app/layout.tsx                — Root layout, OG metadata (1200×630)
app/api/header/route.tsx      — OG image generation (Edge, ImageResponse)
app/api/version/route.ts      — Build ID endpoint (used for hot-reload detection)
```

---

## 11. Routing Rules (Canonical)

These rules are **non-negotiable**. Any change to routing logic must be validated against all five test cases:

| Input | Expected route | Tool called |
|-------|---------------|-------------|
| "swap 1 eth to usdc" | execution → Delora | `parseIntent` + `resolveLeg` |
| "what are people betting on" | prediction → Polymarket | `getTopMarkets` |
| "best yield on usdc" | yield → DeFiLlama | `getTopYields("USDC")` |
| "what is ethereum" | informational → LLM | `getGroqInformationalReply` |
| "should i buy eth" | informational → LLM | `getGroqInformationalReply` (NO price returned) |

**Hard rules:**
- Tool availability > LLM. If a tool can answer, use it. Never use LLM for live data.
- No cross-routing. A prediction query never touches Delora. A yield query never returns price data.
- No mixed output. Don't combine a tool result with LLM speculation.
- If a tool fails → return `{ type: "error", text: "Unable to fetch reliable data right now." }` — never hallucinate a substitute.
- LLM (Groq) has two roles only: explanation (informational queries) and constrained fallback. Both use `GROQ_INFORMATIONAL_SYSTEM`, not the general chat system.
