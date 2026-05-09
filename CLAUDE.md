# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

---

## Commands

```bash
pnpm dev        # Start dev server (Next.js 16 / Turbopack)
pnpm build      # Production build
pnpm lint       # ESLint
```

No test suite — verification is manual against the chat UI.

---

## Architecture

**Skopos** is a cross-chain DeFi copilot deployed at https://www.tryskopos.xyz (Vercel, auto-deploys from `main`).

### Request flow

```
POST /api/chat { message, senderAddress, solanaAddress, history, slippage }
  → rate limiter (30 req/min/IP, in-memory per serverless instance)
  → special handlers short-circuit (ENS, address, tx hash, portfolio, rebalance)
  → missing-source guard  ← hard error, no LLM
  → classifyIntent()      ← pure regex, no LLM
      "fx"          → Pyth Hermes (EUR/USD, GBP/USD, USD/JPY, USD/CHF, AUD/USD)
      "metal"       → Pyth Hermes (XAU/USD, XAG/USD)
      "equity"      → Pyth Hermes (AAPL, MSFT)
      "price"       → priceCache (CoinGecko → DexScreener fallback)
      "execution"   → parseIntent() → resolveLeg() → Delora quote
      "informational" → Groq chat reply
      "analysis"    → DexScreener token risk scan
      "yield"       → DeFiLlama yield pools
      "prediction"  → Polymarket markets
      "unknown"     → Groq suggestions + streaming fallback
```

### Intent parsing (two-layer)

`lib/parseIntent.ts` has two layers chained via `parseIntent()`:

1. **`regexParse()`** — 8 ordered patterns (pCross → p1 → p2 → p5Cross → p3 → p6 → p4 → p5). Covers ~90% of inputs, instant, free.
2. **`groqParseIntent()`** — Groq `llama-3.1-8b-instant` JSON-mode fallback. Only fires if regex returns null **or** the regex result contains an unresolvable chain name.

`parseIntent()` applies a chain-validation gate: if `resolveChainId()` fails for either origin or destination from the regex result, it falls through to Groq instead of returning the bad result.

`classifyIntent()` is a pure-regex classifier — it never calls an LLM.

### Key data structures

- `lib/pyth.ts` — Pyth Hermes REST wrapper (`getPythRates`, `getPythRate`, `toUSDRate`). **Never** replaces `priceCache.ts` — fills gaps only (FX, metals, equities). Feed IDs and cross-rate math documented in `docs/pyth-integration.md`.
- `ParsedIntent` — `{ originChain, destinationChain, token, amount, destinationToken }`
- `CHAIN_IDS` in `lib/chains.ts` — NLP alias map ("ethereum" → 1, "base" → 8453, etc.)
- `CHAIN_AS_TOKEN` in `lib/parseIntent.ts` — chain names users say as tokens ("move 1 base to arb")
- `TOKEN_IMPLIES_SOURCE` in `app/api/chat/route.ts` — token symbols that imply their origin chain (SOL → solana)
- `NON_CHAIN_TOKEN_DEST_RE` — detects pure token names in the dest slot to give helpful "which chain?" errors

### 4 chain maps — must stay in sync when adding a chain

| File | Purpose |
|---|---|
| `lib/chains.ts` → `CHAIN_IDS` | NLP alias resolution |
| `lib/wagmi.ts` → `SUPPORTED_CHAINS` | Wallet connection + tx signing |
| `app/app/page.tsx` → `EXPLORER_URLS` | Block explorer links |
| `lib/alchemy.ts` → `ALCHEMY_CHAINS` | Portfolio balance lookups (optional) |

### resolveLeg (execution core)

`resolveLeg()` in `app/api/chat/route.ts` converts a `ParsedIntent` into a Delora quote:
1. `resolveChainId()` → numeric chain IDs
2. `getChainById()` → Delora chain metadata (cached 10 min)
3. `getToken()` → Delora token address (cached 10 min)
4. Solana guard — require `solanaAddress` if either leg is Solana
5. `getQuote()` → Delora `/v1/quotes`

### Wallet / auth

Provider stack (outermost → innermost):
```
SolanaConnectionProvider → SolanaWalletProvider → PrivyProvider → QueryClientProvider → WagmiProvider
```

`connectedAddress` derivation in `app/app/page.tsx`:
```typescript
const { address } = useAccount();                                    // wagmi active connector
const { wallets } = useWallets();                                    // all Privy wallets
const privyEvmWallet = wallets.find(w => w.address?.startsWith("0x"));
const connectedAddress = address ?? privyEvmWallet?.address ?? null;
```

Ghost session (authenticated but no EVM address): `logout().then(() => login())`.

---

## Environment Variables

```
DELORA_API_KEY
DELORA_INTEGRATOR        # default "ANU"
GROQ_API_KEY
ALCHEMY_API_KEY
NEXT_PUBLIC_PRIVY_APP_ID
NEXT_PUBLIC_PRIVY_CLIENT_ID
NEXT_PUBLIC_SOLANA_RPC   # optional
```

---

## LLM Usage Rules

All LLM calls use Groq `llama-3.1-8b-instant`.

- `classifyIntent` and `regexParse` — **no LLM, pure regex**
- `groqParseIntent` — JSON mode, temp=0, guarded by `chainMentioned` sanity check
- `getGroqInformationalReply` / `getGroqReply` — guarded by `redactLiveNumbers` (strips price claims)
- `streamSuggestion` — streaming fallback, **no** `redactLiveNumbers` (known gap)

Never add LLM calls outside `lib/parseIntent.ts`.

---

## External Services

| Service | Used For | Key Env Var |
|---|---|---|
| Delora (`api.delora.build`) | Quotes + calldata | `DELORA_API_KEY` |
| Groq | LLM (all calls) | `GROQ_API_KEY` |
| Alchemy | Portfolio, tx lookup, ENS | `ALCHEMY_API_KEY` |
| CoinGecko (free tier) | Price data (primary) | none |
| DexScreener | Price fallback + token risk | none |
| DeFiLlama | Yield pools | none |
| Polymarket Gamma | Prediction markets | none |
| Pyth Hermes (`hermes.pyth.network`) | FX rates, metals, equities | none |

**Price source ownership** — never duplicate across sources:
| Query type | Source |
|---|---|
| Crypto spot price | CoinGecko → DexScreener (`priceCache.ts`) |
| 7-day sparkline | CoinGecko (`priceCache.ts`) |
| FX conversion / rate | Pyth (`lib/pyth.ts`) |
| Gold / silver | Pyth (`lib/pyth.ts`) |
| Equity price | Pyth (`lib/pyth.ts`) |

All external fetches use an 8s `AbortController` timeout via `fetchWithTimeout()`.

---

## Docs

`docs/skopos-system.md` — authoritative architecture reference, update when anything structural changes.  
`docs/skopos-core.md` — deeper architecture and routing waterfall detail.  
`docs/pyth-integration.md` — verified feed IDs, Hermes API endpoints, cross-rate math, staleness rules. Update when adding new Pyth feeds.
