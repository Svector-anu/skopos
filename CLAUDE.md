# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

---

## Commands

```bash
pnpm dev        # Start dev server (Next.js / Turbopack)
pnpm build      # Production build
pnpm lint       # ESLint
```

No test suite — verification is manual against the chat UI.

---

## Architecture

**Skopos** is a non-custodial crypto copilot deployed at https://www.tryskopos.xyz (Vercel, auto-deploys from `main`). Beyond cross-chain swaps/bridges/payments, it covers live prices/FX/metals/equities, smart-money intel, Aeon market-intelligence reads, token safety/deep-dives, token picks, DAO treasury lookups, standing price/market/onchain alerts, and prediction markets — and is embeddable via a headless API, an Agent Skill (`SKILL.md`), and an MCP server (`skopos-mcp` on npm), not just the web app.

### LLM stack

All LLM calls use **Groq** (`groq-sdk`, model `llama-3.1-8b-instant`). The `@anthropic-ai/sdk` package is installed but not imported or used anywhere — it is a leftover dependency. Do not add Claude/Anthropic API calls.

### Request handler — 3 layers (`app/api/chat/route.ts`)

The POST handler executes checks in strict order. Each layer short-circuits on match — later layers never run.

**Pre-layer: fast-paths** (run before structural checks)
- Guided buy/sell (`buy TOKEN on CHAIN` / `sell TOKEN on CHAIN`) → conversational prompt asking for amount
- Price fast-path (`queryType === "price"`) → CoinGecko/DexScreener price card
- FX / Metal / Equity → Pyth Hermes rate

**Layer 1 — STRUCTURAL** (format-based, no intent classification, no wallet required)
- ENS name (`*.eth`) → resolveENS → address card
- Embedded `0x40` address in sentence → address card
- `0x64` tx hash → tx card
- Bare `0x40` address → address card

**Layer 2 — ACCOUNT** (wallet-state queries, runs before `classifyIntent`)
- Portfolio keywords → lookupAddress → address card
- Polymarket balance keywords → pUSD balance check
- Deposit address embedded + balance keywords → deposit status

**Layer 3 — INTENT** (`classifyIntent()` → specialized tool → LLM fallback)
- `META_RE` security boundary fires first — blocks model-identity questions before any LLM path
- Multi-leg rebalance check (`looksLikeRebalance`) runs before single-leg parse
- Missing-source guard fires before `parseIntent` to prevent Groq hallucinating a source chain
- Remaining intent types: `execution` → `resolveLeg()` + Delora quote; `informational` → Groq; `analysis` → DexScreener scan; `yield` → DeFiLlama; `prediction` → Polymarket
- Final fallback: `getGroqInformationalReply`

### Intent parsing (two-layer, `lib/parseIntent.ts`)

`parseIntent()` chains two layers:
1. **`regexParse()`** — 8 ordered patterns (pCross → p1 → p2 → p5Cross → p3 → p6 → p4 → p5). Covers ~90% of inputs, instant, free.
2. **`groqParseIntent()`** — Groq JSON-mode fallback. Fires only when regex returns null **or** the regex result contains an unresolvable chain name.

`classifyIntent()` is pure regex — never calls an LLM.

### Decision analysis (`generateDecisionAnalysis`)

Prompt builders for token risk, yield, and bridge quotes live in `route.ts` (`buildTokenAnalysisPrompt`, `buildYieldAnalysisPrompt`, `buildBridgeAnalysisPrompt`). The actual Groq call (`generateDecisionAnalysis`) lives in `parseIntent.ts`. Analysis is additive — `...(analysis && { analysis })` — never breaks existing rendering when Groq fails.

APY outlier filter: `pools.filter(p => p.apy <= 10_000)` before passing to yield prompt — dead incentive pools can show nonsense APYs.

### Groq output safety

`redactLiveNumbers()` strips price and yield claims from Groq text responses. Applied to: `getGroqInformationalReply`, `getGroqReply`. **Not** applied to `streamSuggestion` (known gap).

### Key data structures

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

## CSS theming

`globals.css` defines `--card-*` CSS variables in `:root` (dark) with `[data-theme="light"]` overrides. All card components (standalone, no access to the `T` theme object) must use these vars — never hardcode `rgba(255,255,255,...)`. SVG presentation attributes do not resolve CSS variables; use the React `style` prop instead (`style={{ stroke: "var(--card-text-faint)" }}`).

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
BANKR_PARTNER_KEY        # optional — enables in-chat token launch via Bankr Partner Deploy API
BANKR_LLM_KEY            # optional — enables the ✦ Smart tier (Bankr LLM Gateway)
UPSTASH_REDIS_REST_URL   # optional — Smart-tier metering store; absent → metering fails open (uncapped)
UPSTASH_REDIS_REST_TOKEN # optional — pairs with UPSTASH_REDIS_REST_URL
SMART_FREE_DAILY_CAP     # optional — free Smart messages/day per wallet (default 20)
SMART_TOKEN_GATE_MIN     # optional — tier-1 min whole $skopos held to get the holder cap; unset/0 → token gate disabled (no behavior change)
SMART_HOLDER_DAILY_CAP   # optional — tier-1 Smart messages/day for $skopos holders (default 100)
SMART_TOKEN_GATE_T2_MIN  # optional — tier-2 min whole $skopos (unset → tier-2 inactive)
SMART_HOLDER_T2_CAP      # optional — tier-2 Smart messages/day (default 250)
SMART_TOKEN_GATE_T3_MIN  # optional — tier-3 min whole $skopos (unset → tier-3 inactive)
SMART_HOLDER_T3_CAP      # optional — tier-3 Smart messages/day (default 1000)
SKOPOS_TOKEN_ADDRESS     # optional — $skopos ERC-20 on Base for the holder balance read (default the launched CA)
SMART_ANON_TEASER_CAP    # optional — free Smart messages for anonymous (no-wallet) users before connect paywall (default 2)
SMART_AGENT_DAILY_CAP    # optional — global daily cap on agent Smart messages before degrading to Fast (default 500)
SMART_AGENT_HANDLE_DAILY_CAP # optional — per-VAN-handle daily cap on agent Smart messages before degrading to Fast (default 50)
NEXT_PUBLIC_SUBSCRIBE_URL # optional — Bankr x402 Cloud subscribe endpoint URL; absent → paywall Subscribe inert. Price set in bankr.x402.json
AGENT_TEXT_INTEL_DAILY_CAP # optional — per-anonId daily cap on headless text-mode (format:"text") intel reads, which spend x402 inline (default 15). FAILS CLOSED — no anonId / Upstash down → the read is refused, not spent
CRON_SECRET              # required to authenticate /api/cron/watchers — unset → all requests rejected with 401 (fails closed)
RELAY_SECRET             # required to authenticate /api/vara (the relay/ Vara bridge's inbound webhook) — unset → all requests rejected with 401 (fails closed)
```

---

## LLM Usage Rules

- `classifyIntent` and `regexParse` — **no LLM, pure regex**
- `groqParseIntent` — JSON mode, temp=0, guarded by `chainMentioned` sanity check
- `getGroqInformationalReply` / `getGroqReply` — guarded by `redactLiveNumbers`
- `streamSuggestion` — streaming fallback, **no** `redactLiveNumbers` (known gap)
- Prompt builders live in `route.ts`; Groq calls must stay in `lib/parseIntent.ts`

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
`docs/headless-text-mode.md` — `/api/chat` `format:"text"` for agents/bots (imessage-i, CLI, MCP): request/response contract, per-type text, the fail-closed intel cost cap. Update when adding card types or changing the text projection (`lib/cardToText.ts`).
`skills/skopos/SKILL.md` + `mcp/` — Skopos as an installable agent skill (Agent Skills SKILL.md standard) and an MCP server (`skopos-mcp`), both thin wrappers over the headless API. `skills/README.md` has per-tool install paths. Keep the skill's capability list in sync with what text mode actually returns.
