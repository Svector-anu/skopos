# PROJECT_STATE.md

> Reconstructed handoff document for **Skopos**, written 2026-08-20 by archaeology over the
> repository, its full git history (417 commits), the live production deployment, and the
> private GitHub issue tracker.
>
> **Evidence convention used throughout:**
> **[Confirmed]** — directly established from code, git history, a live probe, or the issue tracker.
> **[Likely]** — strongly suggested by evidence, not directly proven.
> **[Unknown]** — insufficient evidence; needs a human or a credentialed check.
>
> Nothing in the repository was modified to produce this document, except: `pnpm install` and
> `npm install` in `relay/` (both gitignored), and build/lint runs that write only to `.next/`
> (gitignored). Working tree was clean before and after.

---

## 1. Project Overview

**Skopos** is a non-custodial, cross-chain crypto copilot. A user (or an agent) says what they
want in plain English — "bridge 0.1 ETH from ethereum to base", "who is buying $pepe", "sell 2
NVDA if it drops below $400" — and Skopos classifies the intent, calls the right live data source
or routing aggregator, and returns either an answer or a transaction **staged for the user to
sign in their own wallet**. Skopos never holds keys, never signs, never custodies. [Confirmed —
`docs/skopos-core.md` §6, `app/api/chat/route.ts` returns calldata only; all signing happens in
`app/app/page.tsx` via wagmi/Privy/Phantom]

The product is deliberately **four surfaces over one routing brain**:

| Surface | What it is | Where |
|---|---|---|
| Web app | The chat UI at tryskopos.xyz/app | `app/app/page.tsx` |
| Headless API | `POST /api/chat` with `format:"text"` — plain-text answers for bots/agents | `lib/cardToText.ts`, `docs/headless-text-mode.md` |
| Agent Skill + MCP | `SKILL.md` and the published `skopos-mcp` npm package, both thin wrappers on the headless API | `skills/skopos/`, `mcp/` |
| Agent-payable x402 API | 10 x402-priced JSON endpoints other agents' wallets pay for in USDC on Base | `lib/agentcashRouter.ts` |

Plus a fifth, on-chain: an **agent-to-agent oracle on Vara Network** — a Gear/Sails smart contract
(`gear-bridge/`) emits a request event, an off-chain relay service (`relay/`) picks it up, queries
Skopos, and writes the answer back on-chain.

**Business model** [Confirmed from code]: 0.05% Delora integrator fee on swaps (currently
collecting nothing — see §9), a $5/30-day "Smart" LLM-tier subscription paid via x402, a `$skopos`
token holder gate that raises free Smart caps, and per-call x402 revenue from the agent-payable API.

**Production:** https://www.tryskopos.xyz — Vercel, auto-deploys on push to `main`. Verified live
2026-08-20 (see §13).

---

## 2. Current State — honest summary

The project is **shipped, live, and working**, but **dormant since 2026-07-26** (last commit;
`gh repo view` confirms `pushedAt: 2026-07-26`). That is ~3.5 weeks of no activity as of writing.

- The core product works right now. A live probe of `/api/chat` returned a correct ETH price card
  and a correct swap-quote handoff link. [Confirmed — §13]
- The build **does not succeed from a clean checkout without secrets** — `lib/agentcashRouter.ts`
  throws at module load. This is the single biggest onboarding blocker on a new machine. [Confirmed]
- One user-facing feature is **serving month-old data**: all Aeon "market read" answers ("what's
  the narrative", "defi read today", "token pick") come from a fork whose cron last ran
  **2026-07-28**. Production serves that read today, dated. [Confirmed — §13]
- The codebase is unusually **disciplined for a solo project**: dense, honest, decision-recording
  comments; consolidated infra helpers; fail-open/fail-closed choices stated explicitly per module.
  There is almost no dead code and almost no `TODO`.
- The weak spots are structural, not sloppy: **no CI**, **no tests outside `relay/`**, a
  **5,781-line frontend file**, and **documentation that has drifted behind the code** in specific,
  identifiable places.

| Area | State |
|---|---|
| Chat routing brain (`/api/chat`) | **Complete**, live-verified |
| Swap/bridge via Delora | **Complete** |
| Prices (crypto/FX/metals/equities) | **Complete** |
| Portfolio / ENS / tx lookup | **Working but fragile** — 10 of 25+ chains only (issue #34) |
| Smart-money intel (Nansen x402) | **Complete** on the server-paid path; **stubbed/unverified** on the user-signed path |
| Aeon market reads | **Working but fragile** — upstream cron is stale since 2026-07-28 |
| Robinhood Chain (Flash + Relay) | **Complete** for market swaps, advanced orders, bridging |
| Agent-payable x402 API | **Complete**, discovery live at `/openapi.json` |
| MCP server / Agent Skill | **Complete** (`skopos-mcp@0.1.0` published on npm 2026-07-08) |
| Vara A2A oracle | **Working but fragile** — relay is up but has processed 0 requests since restart, and has no persistent disk |
| Alerts / watchers / Web Push | **Partially implemented** — daily cron only, bare notifications (issue #75) |
| Polymarket | **Partially implemented** by design — read + deposit only, no order placement |
| Token launch (Bankr) | **Stubbed** — gated behind an unset env var |
| Subscription purchase (x402) | **Unknown / needs verification** — compile-verified only, never exercised live |
| CI / tests (main app) | **Planned but not implemented** (issue #78) |

---

## 3. Architecture

### 3.1 Runtime topology

```
                      ┌────────────────────────────────────────────┐
 Browser ────────────▶│  Next.js 16 app on Vercel (this repo)      │
 Agents / bots ──────▶│  auto-deploy from `main`                   │
 Other agents (x402) ▶│                                            │
                      │  app/page.tsx        landing (no wallet)   │
                      │  app/app/page.tsx    chat UI + all signing │
                      │  app/api/chat/route  THE ROUTING BRAIN     │
                      │  app/api/<paid>/     x402 merchant routes  │
                      │  app/api/vara        A2A oracle handler    │
                      │  app/api/cron/...    Vercel Cron (daily)   │
                      └───────┬────────────────────────────────────┘
                              │
      ┌───────────────────────┼───────────────────────────────────┐
      ▼                       ▼                                   ▼
 External data          Upstash Redis                    Skopos agent wallet
 Delora, Flash,         metering, subs, watchers,        (SKOPOS_X402_PRIVATE_KEY)
 Relay.link, Groq,      push subs, A2A KPI counter       pays Nansen / Chain Intel
 Bankr LLM gateway,                                      over x402 in USDC on Base
 Alchemy, Blockscout,
 CoinGecko, DexScreener,
 DeFiLlama, Polymarket,
 Pyth, Nansen, Jina


 Vara Network (separate deploy, NOT on Vercel)
 ┌──────────────────────┐        ┌───────────────────────────┐
 │ gear-bridge/ (Rust)  │ event  │ relay/ (Node, Fly.io)     │
 │ Sails program on     │───────▶│ subscribes to finalized   │
 │ Vara mainnet         │        │ blocks, calls /api/vara,  │
 │ request_data()       │◀───────│ submits fulfill_request   │
 │ fulfill_request()    │ tx     │ + VAN chat agent loops    │
 └──────────────────────┘        └───────────────────────────┘

 Bankr x402 Cloud (separate deploy, NOT in this app)
 ┌──────────────────────────────────────────────┐
 │ x402/skopos-subscribe/index.ts               │
 │ runs at x402.bankr.bot after USDC payment,   │
 │ writes sub:<wallet> to the SAME Upstash      │
 └──────────────────────────────────────────────┘

 Aeon fork (separate repo, GitHub Actions cron)
 Svector-anu/skopos-aeon (renamed → svectors-lab), a fork of aeonfun/aeon.
 Commits market reads as .md; lib/aeonFeed.ts fetches raw + caches 15 min.
```

### 3.2 The routing brain — `app/api/chat/route.ts` (3,428 lines)

Everything backend flows through one POST handler. It is a strictly ordered waterfall; **each
block returns early on match, so later layers never run**. The order is load-bearing — it encodes
years of "this query was getting misrouted" fixes. [Confirmed — read in full]

```
POST /api/chat
 └─ POST() wrapper           peeks format/anonId/senderAddress, calls handleChat(),
                             then projects the card to text if format:"text"
 └─ handleChat()
    0.  body-size guard (64 KB) → rate limit (30/min/IP, in-memory)
    1.  smart-quote normalization  ← iOS curly apostrophes broke every trigger regex
    2.  length guard (2000 chars, ReDoS)
    3.  HARMFUL-CONTENT BOUNDARY  ← fires before ANY routing, incl. LLM-enriched cards
    4.  Smart-tier metering gate  ← subscription → holder cap → free cap → paywall
    5.  inline Solana address extraction, slippage sanitation
    6.  classifyIntent()          ← PURE REGEX, never an LLM

    PRE-LAYER fast paths (before structural checks):
      embedded URL → x402 discovery, else Jina web-context card
      6× Aeon reads (narrative/defi/trending/protocols/fear/x402) — all token-guarded
      5× Nansen intel reads (screener/flow-intel/flows/holders/token-intel)
      guided Robinhood stock buy · guided buy/sell · guided RH bridge
      Flash advanced orders (limit/stop-loss/take-profit/TWAP) ← regex, then LLM fallback
      token deep-dive · pre-buy research bundle · token pick · picks tracker
      3× alert registrations · DAO treasury · RH launch feed · stock-paired intel
      FX / metals / equities (Pyth)

    LAYER 1 — STRUCTURAL (format-based, no intent, no wallet)
      *.eth → ENS · 0x40 in sentence · 0x64 tx hash · bare 0x40
      approval scanner · Flash order status

    LAYER 2 — ACCOUNT (wallet-state; runs before intent so it can't be misrouted)
      portfolio · Polymarket balance · deposit status

    LAYER 3 — INTENT
      META_RE identity boundary → HELP_RE → MCP_RE → NOT_LIVE list
      B20 pay · payments inbox · token launch
      looksLikeRebalance → parseRebalanceIntent (multi-leg)
      missing-source guard  ← fires BEFORE parseIntent so Groq can't invent a source chain
      prediction → Polymarket
      informational → LLM (before parseIntent, to avoid a wasted call)
      dollar-amount guard  ← rewrites "$5 of ETH" to a token quantity BEFORE parsing
      single-leg execution → parseIntent → resolveLeg → Delora quote
      token risk scanner · yield scanner
      final fallback → getInformationalReply (redacted, or grounded on live price)
```

**Invariant this file encodes: a tool always beats the LLM.** The LLM is used for exactly three
things — intent extraction fallback, explanation, and narration of numbers the code already
computed. It is never the source of a price, APY, TVL, balance, or gas figure.

### 3.3 Intent parsing — `lib/parseIntent.ts` (1,051 lines)

- `classifyIntent()` — pure regex, 11 intent types, priority-ordered. **No LLM, ever.**
- `parseIntent()` — two layers: `regexParse()` (8 ordered patterns, covers ~90%, free and
  instant), then `groqParseIntent()` (JSON mode, temp 0) only when regex returns null *or* the
  regex result names an unresolvable chain.
- `llmParseFlashOrder()` — structured order parse with **provenance validation**: every number in
  the parsed order must appear in the user's message, or it is discarded and the bot asks. This is
  a genuinely good safety design worth preserving. [Confirmed — `validateProvenance()`, line 602]
- LLM tiering: **Fast** = Groq `llama-3.1-8b-instant`; **Smart** = `claude-haiku-4.5` via the
  **Bankr LLM Gateway** (`llm.bankr.bot/v1`, driven by direct `fetch` because groq-sdk hardcodes
  `/openai/v1`). Any gateway failure silently degrades to Fast — a Smart outage never breaks a reply.
- `redactLiveNumbers()` strips `$X` and `X% APY` from LLM output — **except in grounded mode**,
  where real fetched numbers were handed to the model on purpose.

### 3.4 Chain configuration — five maps that must stay in sync

| File | Map | Purpose |
|---|---|---|
| `lib/chains.ts` | `CHAIN_IDS` | NLP alias → chain ID (what a user can *type*) |
| `lib/wagmi.ts` | `SUPPORTED_CHAINS` | wallet connection + tx signing |
| `app/app/page.tsx` | `EXPLORER_URLS` | keyed by chain **name**, not ID |
| `lib/alchemy.ts` | `ALCHEMY_CHAINS` | portfolio balances (10 chains) |
| `lib/blockscout.ts` | `BLOCKSCOUT_CHAINS` | portfolio fallback for 9 chains Alchemy/Ankr miss |

Verified drift as of today [Confirmed]:
- zkSync Era (324) is in `ALCHEMY_CHAINS` but **not** in `CHAIN_IDS` or `SUPPORTED_CHAINS` — its
  balances appear in a portfolio, but a user cannot name it and cannot sign a tx on it.
- Robinhood Chain (4663) is in `CHAIN_IDS` but is deliberately **not** a Delora chain — it routes
  through Flash and Relay.link instead. This is intentional and commented.

---

## 4. Core Workflows

### 4.1 Swap / bridge (the original product)

```
"swap 1 eth to usdc on base"
 → classifyIntent → "execution"
 → dollar-amount guard (no-op here)
 → parseIntent: regexParse hits p1 → { origin: base, dest: base, token: ETH, destToken: USDC, amount: 1 }
 → resolveLeg():
     resolveChainId ×2 → getChainById (Delora /v1/chains, 10-min cache)
     → getToken (Delora /v1/tokens, 10-min cache) → toWei
     → Solana guard (requires solanaAddress if either leg is Solana)
     → getQuote (Delora /v1/quotes, integrator + 0.05% fee)
     → REVERTED-simulation guard: if Delora's own sim says it reverts, REFUSE the route
 → { type:"quote", mode:"preview", quotedAt, intent, route, approval, calldata }
 → browser: QuoteDisplay → ERC-20 approve if needed
            → onRevalidate() RE-QUOTES right before signing (no server-side TTL; the
              re-quote is the staleness defence) → wagmi sendTransaction
```

**Robinhood Chain (4663) is a different path entirely** — Delora doesn't support the chain:
- same-chain swap → `resolveFlashLeg()` → Flash quote → **EIP-712 signed in the browser** →
  `POST /api/flash/submit` (server-mediated, because Flash's API key must never reach the browser)
- getting funds on/off the chain → `resolveRelayLeg()` → relay.link → raw `{to,data,value}` tx
- advanced orders → `resolveFlashOrderLeg()`, chain chosen from the wallet's actual balances

**Flash's two paths have deliberately different reach — don't conflate them** [Confirmed]:

| Flash path | Chains | Entry point |
|---|---|---|
| **Market swap** | **Robinhood Chain only.** Hard-refuses anything else: "Flash trades happen directly on Robinhood Chain — both sides need to be there" | `resolveFlashLeg()`, route.ts:549 |
| **Advanced orders** (limit / stop-loss / take-profit / TWAP) | **8 chains** — ethereum, base, arbitrum, optimism, polygon, bsc, avalanche, robinhood | `FLASH_ADVANCED_ORDER_CHAINS`, route.ts:921 |

The `FlashChain` union in `lib/flash.ts:241` declares **12** chains — `solana`, `hyperevm`,
`plasma`, and `monad` are typed but unreachable, explicitly mapped to `undefined` in both
`FLASH_CHAIN_DISPLAY_NAME` and `FLASH_NATIVE_WRAP_SYMBOL`. That is parked-on-purpose, not
forgotten. Relatedly, `FlashSvmAccountMeta` / `FlashSvmInstruction` / `FlashSvmActions` (Solana
instruction scaffolding, `lib/flash.ts:286-317`) are **declared and never referenced outside
`lib/flash.ts`** — dead type scaffolding for a Solana path that was never wired.

Two Flash quirks worth knowing before touching this code: advanced-order quotes **400 on a
chain's native-coin placeholder** ("missing notional rates"), so native orders are routed through
the wrapped token (`FLASH_NATIVE_WRAP_SYMBOL`); and the contra asset is **USDG on Robinhood Chain,
USDC everywhere else** — the chain determines the stablecoin, which is awkward because balance
lookup uses the stablecoin to determine the chain.

### 4.2 Headless agent request

```
POST /api/chat { message, format:"text", anonId }
 → handleChat produces the normal card
 → cardToText(card, {anonId, senderAddress, sparkline})
     · intel cards EXECUTE THE PAID READ INLINE (this is the only path that spends money)
       gated fail-closed on AGENT_TEXT_INTEL_DAILY_CAP + the global intel budget
     · execute intents get a `link` (…/app?q=<message>) — NEVER a signable payload
     · price cards get an `image` (…/api/og/chart?token=)
     · every external string is sanitized (zero-width chars, control chars, length caps)
       so a hostile token name can't smuggle instructions into a consuming agent's context
 → { type, text, link?, image? }
```

### 4.3 Agent-to-agent oracle (Vara)

```
Another Gear program calls bridge.request_data(payload) with ≥ fee_planks VARA
 → BridgeEvent::RequestPending { id, caller, payload } emitted
 → relay/ (Fly.io) sees it in the next finalized block (~6s)
 → dispatcher → POST <skopos>/api/vara  Authorization: Bearer RELAY_SECRET
 → /api/vara switch: price | risk | yield | markets | quote | portfolio | chat
 → incrA2aServed() bumps the permanent kpi:a2a:total counter
 → relay submits bridge.fulfill_request(id, result) — only the relay wallet may call it
 → the requesting program receives the result as a Gear message (~14–16s end to end)
 SQLite (relay.db) persists in-flight requests; on restart, `submitting` requests are
 re-checked with query_pending before re-submission so gas is never double-spent.
```

The relay **also** runs three autonomous loops against the Vara Agent Network: a mention poller
(`@skopos-agent2` / `@skopos-bridge`), a 15-minute proactive broadcaster, and a 20-minute "herald"
that posts questions. All three call `/api/vara` too. [Confirmed — `relay/src/chat-agent.ts`]

### 4.4 Paid agent call (Skopos as merchant)

```
Agent → POST /api/price  (no payment)
 → @agentcash/router returns 402 with the x402 challenge ($0.01, USDC, Base)
 → agent's wallet signs an EIP-3009 authorization, retries with the payment header
 → router verifies/settles via CDP, then runs the handler
 → handler calls THE SAME lib/ function the free chat path calls (getPrice)
```

The reuse rule is architectural, stated in `CLAUDE.md` and honoured in every route: a paid route
never re-implements logic. `/api/quote` returns a route summary + a sign-in link — **never raw
calldata** — preserving the non-custodial contract for agents.

---

## 5. Development History

417 commits, 2026-04-13 → 2026-07-26, single author (`svector-anu`). Eight recognisable phases,
reconstructed from commit clusters. All commit hashes below are [Confirmed].

**Phase 1 — Bootstrap (Apr 13–14).** `1f2f5ed` Create Next App → landing + chat (`1fd9528`) →
regex intent parser + Delora quotes (`246454a`) → wallet/approve/execute (`0fadb9c`) → RainbowKit
replaced by **Privy** social login (`e0f85e4`).

> **Origin of the orphaned Anthropic dependency:** `@anthropic-ai/sdk` entered in `246454a`. On
> Apr 14, `08b9513` **replaced the regex parser with Claude Haiku tool_use extraction**. Six hours
> later `4c46749` replaced *that* with the hybrid regex→Groq parser that survives today. The SDK
> import died then; the dependency never got removed. [Confirmed via `git log -S`]

**Phase 2 — Product surface + rebrand (Apr 15–24).** AI-native block explorer, ENS, portfolio,
Solana/Phantom, token risk + yield scanners, Polymarket, mobile/light-mode. The project was
**renamed from "Delora Copilot" to "Skopos"** here (`f356f80`); the `package.json` name lagged
until `b160547` on Jul 9. The 0.05% integrator fee was added in `1d7fd0d`.

**Phase 3 — Anti-hallucination + data breadth (May 3–10).** `12c8d06` extracted `priceCache`;
`4cee20c`/`23fff3d` hardened intent routing against hallucination; `f612949` added **Pyth** for
FX/metals/equities; `7473c27` added directional "game-theory" decision analysis; `2cb9982`
replaced hardcoded `rgba()` with CSS variables across every card.

**Phase 4 — Vara A2A oracle (May 17 – Jun 3).** The largest single architectural addition.
`4ffc319` landed the whole integration (Rust Sails program + Node relay + `/api/vara`).
`46a98c9` was a dedicated CRITICAL/HIGH security hardening pass over relay/API/chat-agent/oracle.
Then Docker + Railway (`018dc11`) → Fly.io (`f405730`) → proactive broadcaster (`c8e1548`) →
herald + in-chat bridge quotes (`bfb7b8c`).

**Phase 5 — Monetisation + Bankr ecosystem (Jun 20–29).** Nansen smart-money over x402, first
user-signed (`09b3cd4`, marked UNTESTED) then server-signed (`b2f6ef4`+); **Fast/Smart LLM tiers**
(`678c79e`, `755955d`) via the Bankr gateway; Redis metering + paywall (`5e3348a`); x402
subscription (`af0bad4`→`0f8ca60`); `$skopos` holder gate, later tiered (`e88ffcb`, `ef3a392`);
**B20 memo payments** (`a786c84`); public changelog page (`c8508ed`).

**Phase 6 — Intelligence layer (Jul 1–9).** Full Nansen intel suite (`eab4bbe`, `f7ccfa8`); **Aeon
market reads** (`8e9e5d5` via Bankr Agent → `f60bbca` re-pointed at a **self-hosted GitHub Actions
fork**, making the reads cache-first, instant, and free per request); watchers + Web Push
(`d10c5fa`, `d77dacf`); DAO treasury (`128a963`); token picks (`a8171c7`, later swapped to Aeon's
real skill in `9f71c85`). Also a security sweep: `f04e804` and `ce52b75` made the cron and intel
routes **fail closed** instead of open.

**Phase 7 — Embeddability (Jul 3–12).** This is where Skopos stopped being a web app.
`fab4c0f`/`cabf1a8` headless text mode → `a694be2` **MCP server** → `82693f3` **Agent Skill** →
`392caab`/`ca2b1a6` **agent-payable x402 API** → `7d9a3ac` generic x402 client → `fb82e1c`
**Mintlify docs site** (21 pages) replacing the in-app `/docs`. `c677413` consolidated the
duplicated infra helpers into `lib/http.ts` + `lib/redis.ts`.

**Phase 8 — Robinhood Chain (Jul 12–26).** The final and densest arc. Launch feed (`a6005c9`) →
Flash market swaps (`83d00a0`) → relay.link bridging (`526b470`) → the four advanced order types
(`4c1c0a3`) → official **tokenized stock registry** (`fc9452c`) → advanced orders extended to 7
more EVM chains (`22cae14`) → LLM order-parse fallback with provenance checking (`ad9e2be`) →
order status + cancel (`25f0b2e`) → **stock-paired token intelligence** (`c7da7dd`), the most
product-original feature in the repo. Interleaved: a jailbreak fix (`2f0c5a5`), prompt-injection
sanitisation (`f6c8803`, `fd97277`), the push-subscribe signature requirement (`8d4d00b`), and the
wallet approval scanner (`cad7995`).

**Trajectory in one line:** Skopos evolved from *a chat front-end for one bridge aggregator* into
*a routing brain with four consumer surfaces and its own two-sided x402 economy* — buying data from
Nansen and Chain Intel with its own wallet, and selling answers to other agents from the same brain.

---

## 6. Integrations — what came from elsewhere

| Thing | Origin | Status | Evidence |
|---|---|---|---|
| **Aeon** (market reads, token picks) | Fork of `aeonfun/aeon` (originally `aaronjmars/aeon`), run as `Svector-anu/skopos-aeon` — **since renamed to `Svector-anu/svectors-lab`** | Integrated, **upstream cron stale since 2026-07-28** | `lib/aeonFeed.ts` header; GitHub API shows the rename + `fork: true, parent: aeonfun/aeon`. Raw URLs still 200 because GitHub follows renames [Confirmed by live probe] |
| **Delora** (`api.delora.build`) | Third-party swap/bridge aggregator | Live, primary execution path for 25 chains + Solana | `lib/delora.ts` |
| **Flash / Definitive** (`flash.definitive.fi`) | Third-party execution API | Live; **falls back to a hardcoded key if `FLASH_API_KEY` is unset**. The key literal in `lib/flash.ts:233` is **not a leaked credential** — I fetched `flash.definitive.fi/openapi.json` and it is Definitive's own published shared dev key, exactly as the code comment claims. Still shared/public: set a real key before production traffic | `lib/flash.ts:225-239` [Confirmed by live probe] |
| **Relay.link** | Third-party bridge | Live, Robinhood-Chain-only | `lib/relay.ts` |
| **@agentcash/router** | agentcash.dev SDK | Live merchant layer; **its config throws at module load** | `lib/agentcashRouter.ts` |
| **Bankr** | LLM gateway, x402 Cloud subscription host, Partner Deploy (token launch), `$skopos` token | Gateway + subscription live; token launch stubbed behind an unset key | `lib/parseIntent.ts`, `x402/`, `lib/bankr.ts` |
| **Nansen Token God Mode** | Paid data, x402 | Live, Skopos's wallet pays ~$0.01–0.05/call | `lib/smartMoneyServer.ts`, `docs/paid-data-sources.md` |
| **x402 Chain Intel** | Paid sniper detection, $0.18/call | Live on Base only. **Replaced HYRE Agent on 2026-07-15** after HYRE 500'd on every well-formed payment | `lib/sniperCheck.ts` |
| **Vara / Gear / Sails** | `sails-rs` 1.0.0-beta.5, `@gear-js/api` | Program deployed to Vara mainnet; relay on Fly.io | `gear-bridge/`, `relay/` |
| **Jina Reader** (`r.jina.ai`) | Free web-context fetch | Live | `lib/intel.ts` |
| **Blockscout** | Public explorers, keyless | Live for 9 chains; Metis deliberately excluded (legacy fork, wrong schema) | `lib/blockscout.ts` |

**Licensing / attribution notes** [Confirmed]: the repo carries an MIT `LICENSE` (added
`464d63b`). `mcp/package.json` declares MIT. The Aeon integration is a **fork of a third-party
repo running in the owner's own GitHub account** — the fork itself carries whatever licence
`aeonfun/aeon` uses; nothing in this repo vendors Aeon's code, it only fetches the fork's committed
output over HTTP, so the coupling is data-level, not code-level. Commit `6df556a` deliberately
**dropped visible Bankr/Aeon credit from the card UI** in favour of Skopos-owned branding — worth a
second look if the upstream licence expects attribution. [Unknown — upstream licence not checked]

**Nothing in this repo appears copied-but-unadapted.** Every third-party surface is behind a
purpose-written `lib/` client with its own comments explaining the observed quirks.

---

## 7. Completed Work

Genuinely finished, verified by reading the code *and* (where marked) probing production:

- **The routing waterfall.** ~50 ordered dispatch blocks with the ordering rationale in comments.
- **Swap / bridge / rebalance execution** including multi-leg splits, EVM↔Solana, re-simulation
  before signing, and refusal of routes Delora's own simulation says will revert.
- **Price stack** — CoinGecko → DexScreener for crypto, Pyth for FX/metals/29 equities+ETFs, with
  strict per-query-type source ownership (no source is ever used for two purposes).
- **Headless text mode** — every card type has a text projection, external strings sanitised,
  execute intents downgraded to a link. **Live-verified today.**
- **`skopos-mcp` on npm** — v0.1.0, published 2026-07-08. [Confirmed via registry]
- **Agent-payable x402 API** — all 10 routes present in the live `/openapi.json`. [Confirmed]
- **Robinhood Chain**: market swaps, the four advanced order types across 8 chains, the 25-token
  official stock registry, order status + cancel, bridging on/off, stock-paired intelligence.
- **Security hardening pass** (Jul 17–21): jailbreak boundary before all routing, prompt-injection
  sanitisation on both the LLM-input and agent-output sides, signed-challenge push subscription,
  wallet approval scanner across 10 chains.
- **Vara oracle contract + relay service**, with the only test suite in the repo — **59 tests, all
  passing** (45 vitest + 14 node:test). [Confirmed — ran them]
- **zh/vi localisation** of landing + full app UI via next-intl, with the deliberate rule that
  anything handed back to the English-only intent parser keeps its English command.
- **Infra consolidation** — one `fetchWithTimeout` (`lib/http.ts`), one `getRedis` (`lib/redis.ts`),
  one x402 signer (`lib/x402Agent.ts`), one wallet-signer adapter (`lib/x402ClientSigner.ts`).

---

## 8. In-Progress / Unfinished Work

**Genuinely unfinished, with evidence:**

1. **`public/skopos-skill.md` is one hardening pass behind `skills/skopos/SKILL.md`.** The very
   last feature commit (`d927679`, 2026-07-26) added x402 pins, a confirmation gate, and a risk
   disclosure to the skill — but only to the `skills/` copy. `public/skopos-skill.md` (98 lines vs
   202) was last touched 2026-07-09. **The Mintlify docs tell users to download the public copy**
   (`mintlify-docs/build/agent-skill.mdx`), so the file people actually install is the un-hardened
   one. [Confirmed — diffed both files and traced both histories]
2. **Delora ↔ Robinhood Chain spike, left mid-flight.** `lib/delora.ts:54` carries the repo's only
   real `TODO`: chain 4663 is confirmed absent from Delora, Li.Fi *does* list it, "Next: a scoped
   Li.Fi quote-only spike before wiring anything into resolveLeg." Never done. Directly causes open
   issue **#82** (the research bundle quotes via Delora only, so every Robinhood Chain token shows
   "couldn't find a route").
3. **Headless advanced orders are blocked** (issue #80). Text mode explicitly refuses them and
   tells the caller to open the app. Deliberate, but incomplete relative to the skill's promises.
4. **User-signed x402 paths are compile-verified only.** `lib/smartMoneyClient.ts`,
   `lib/subscribeClient.ts`, and `lib/x402GenericClient.ts` all carry an explicit
   "COMPILE-VERIFIED ONLY — expect the signer adapter and body shape to need tuning on first real
   run" comment. **This includes the subscription purchase flow — the revenue path.** [Confirmed]
5. **Watchers are minimum-viable.** One daily Vercel cron (`0 13 * * *`), a bare "new activity"
   ping with no USD threshold and no decoded transfer (issue #75), and Web Push only — which
   structurally cannot reach the headless clients the product is otherwise built around.
6. **Token launch (Bankr Partner Deploy)** is scaffolded and reachable but returns "coming soon"
   unless `BANKR_PARTNER_KEY` is set (`fe32ffd`, never followed up).
7. **Planned-not-started integrations** with open issues: stablefinance.dev insider trades / 13F
   (#70), Otto x402 routes (#66), pre-IPO stock tokens (#64), unlock-monitor / pm-manipulation
   reads (#14).

**35 open issues, 0 open PRs.** Note the tracker itself has drifted: **#27** (consolidate duplicate
`fetchWithTimeout`/`getRedis`) is actually **done** — the remaining "duplicates" are thin,
intentional header-injection wrappers over `lib/http.ts`; **#47**'s "broken relay tests" was fixed
in `2d91e62`; **#31**'s dead-code sweep was done in `a63ca23`. Triage the tracker before trusting
it. [Confirmed by inspection]

---

## 9. Known Problems

Ordered by how much they matter to someone picking this up today.

### P0 — Clean checkout does not build

`next build` **fails** without secrets. TypeScript compiles clean (21s, zero errors) and all pages
compile, but page-data collection dies:

```
Error [RouterConfigError]: BASE_URL is required …
  EVM_PAYEE_ADDRESS is required …
  No payment protocol is configured. Set MPP_SECRET_KEY … and/or CDP_API_KEY_ID + CDP_API_KEY_SECRET
Build error occurred: Failed to collect page data for /api/flash-order
```

Cause: `lib/agentcashRouter.ts` calls `createRouterFromEnv()` at **module load**, and
`lib/agentcashRoutesBarrel.ts` eagerly imports all 10 paid routes so discovery works on cold start.
**Confirmed fix:** supplying those four values (even dummies) makes the build succeed end-to-end,
all 39 routes collected. [Confirmed — I ran both]

Also note `pnpm build` fails *before even reaching Next* on pnpm 11 — its dependency status check
re-runs `pnpm install`, which exits 1 on `ERR_PNPM_IGNORED_BUILDS`. Use `./node_modules/.bin/next
build` locally, or approve the build scripts. The `.gitignore` warns that the `pnpm-workspace.yaml`
scaffold "breaks install/build" and must never be tracked — heed that.

### P1 — Aeon market reads are ~3 weeks stale in production

Live probe of `POST /api/aeon/read {"kind":"defi"}` today returns
`"DeFi read — risk-off … — as of 2026-07-28"`. The upstream fork's cron last committed
2026-07-28. Every Aeon-backed answer — narrative, defi read, trending, top protocols, fear
divergence, x402 pulse, **token pick, picks tracker** — is serving that snapshot. It is honestly
dated, but a user asking "what's the narrative today" gets a month-old market call with
"Conviction: high" attached. [Confirmed by live probe]

### P2 — In-app GitHub links 404 for every user

`app/app/page.tsx:1212` and `:1611` link to `github.com/Svector-anu/skopos` and its
`/issues/new` — **that repo is private** (GitHub API returns 404 unauthenticated). The landing page
header and the Mintlify docs instead point at `Svector-anu/skopos-os`, which **is** public but was
last pushed **2026-06-29** — roughly a month behind this repo. So "view source" is either a 404 or
a stale mirror, and "report a bug" is a 404. [Confirmed via GitHub API]

### P3 — Vara relay: running, but processing nothing, on ephemeral storage

`GET https://relay-tranquil-log-8398.fly.dev/` returns
`{"status":"running","lastBlock":0,"db":{"pending":0,"querying":0,"submitting":0,"failed":0,"done":0}}`.
`lastBlock: 0` means the SQLite cursor has never advanced since the container's DB was created.
Compounding this: **`relay/fly.toml` has no `[mounts]` section**, so `relay.db` lives on ephemeral
container storage and is destroyed on every restart — which defeats the crash-recovery design the
CHANGELOG advertises as "Kill-9 safe". [Confirmed]
Whether this means "recently restarted, no requests since" or "the subscription isn't delivering
events" is **[Unknown]** — it needs a look at Fly logs.

### P4 — The A2A KPI counts Skopos talking to itself

`GET /api/stats` returns `{"a2aCallsServed":18432}`. That counter increments on **every**
successful `/api/vara` call — and the relay's own proactive broadcaster calls `/api/vara` **six
times per price round every 15 minutes**, plus a herald every 20 minutes. [Confirmed — the
broadcaster loop and `respond()` both read directly]. The number is therefore dominated by
self-generated traffic, not third-party agent demand. **[Likely]** — I did not separate the
counts. Do not quote it as external traction without instrumenting the caller.

### P5 — The 0.05% integrator fee collects nothing

Documented in `docs/skopos-system.md` §9 P6 and verified there by a prod quote probe on 2026-06-27:
every quote returns `INTEGRATOR_WALLET_NOT_CONFIGURED_FEE_SKIPPED`. Not a code bug — the fee
wallets are linked to a different integrator slug in the Delora Partner Portal. **Related live
hazard:** `lib/delora.ts` now defaults `DELORA_INTEGRATOR` to lowercase `"anu"` (fix `54fd7d1`),
but `.env.example` and `CLAUDE.md` both still say `ANU`. Copying `.env.example` verbatim
re-introduces the exact mismatch that causes the skipped fee. [Confirmed]

### P5b — Signing surface trusts the aggregator (issue #83) — the most security-significant open item

The repo's own audit filed this as medium severity, "trust-the-aggregator class", and I initially
under-weighted it by listing it only as an issue number. It is a **fund-safety** gap on the two
paths that produce something a user signs:

- **Delora:** `resolveLeg()` passes `calldata.to` through verbatim and sets that same address as
  the ERC-20 `approval.spender` (route.ts ~481-484). There is **no allowlist of known router
  contracts**, and the quote card never shows the user the target address.
- **Flash:** `orderTypedData` is passed straight to the browser's `useSignTypedData()`
  (`FlashExecuteButton`, page.tsx ~2580) with **no server-side assertion that
  `message.fromToken` / `qty` match the quote the user was shown**.

Real mitigations already exist and reduce the blast radius: approvals are always exact-amount and
never unlimited, Delora's REVERTED simulation is a hard refusal, and the client re-quotes
immediately before signing. But a compromised or spoofed upstream response could still put a
malicious contract in front of a user's signature, and nothing in the UI would reveal it.

Fix shape (from the issue): log the `calldata.to` addresses Delora actually returns per chain,
pin them and refuse unknowns; assert the Flash typed-data fields against the quote server-side
before returning it; and surface the target contract on the quote card.

### P6 — Rate limiting is per-serverless-instance

`lib/rateLimit.ts` is an in-memory sliding window. On Vercel the effective limit is
`30 × N instances`, and a cold start resets it. The module's own comment is honest about this
("abuse throttling, not a hard security boundary"), and the Redis-backed daily budgets in
`lib/usage.ts` are the real spend ceiling. Fine as designed — just don't mistake it for protection.

### P7 — Two unrelated things are both called "relay"

`relay/` = the Vara oracle relay service, authenticated with **`RELAY_SECRET`**.
`lib/relay.ts` = a relay.link bridge client, configured with **`RELAY_API_KEY`**.
They share no code and no purpose. A newcomer will conflate them. [Confirmed]

### P8 — Lint errors on `main`

`eslint .` reports **2 errors, 3 warnings**: a ref written during render
(`app/app/page.tsx:1881`, `react-hooks/refs`), an unescaped apostrophe (`:4592`), and three
unused-variable warnings. These don't block the Vercel build (Next 16 doesn't run eslint during
`next build`), so they've accumulated unnoticed. [Confirmed — ran it]

### P9 — Subscription grant trusts a client-supplied wallet

`x402/skopos-subscribe/index.ts` credits `body.wallet` because Bankr doesn't hand the handler the
verified payer. A payer can therefore grant the 30-day sub to any address they name. The payer
still pays, so this isn't free entitlement — but it does mean the grant is not bound to the payer.
The code prefers an `x-payment-payer` header if Bankr ever provides one. [Confirmed]

---

## 10. Missing Context — what didn't survive the machine move

**No secrets are in the repository, and none should be added.** What is missing is *configuration*,
and in two cases, *deployments that live outside this repo*.

**Missing locally (must be recreated):**
- `.env.local` — absent. `.env.example` exists but is **incomplete**: 13 env vars referenced in
  code are missing from it. [Confirmed by diff]
  - `CRON_SECRET` — **required**, fails closed; without it `/api/cron/watchers` 401s everything
  - `RELAY_SECRET` — **required**, fails closed; without it `/api/vara` 401s everything (and the
    relay can't reach Skopos)
  - `FLASH_API_KEY` — without it Robinhood Chain silently uses a shared public dev key
  - `SKOPOS_X402_PRIVATE_KEY` — the agent wallet that pays Nansen / Chain Intel; unset ⇒ all
    smart-money intel silently unavailable. Public address is
    `0x6A1Ea639deEc4C42fbAd0A0b53b1b6Aa6CFE3658` (in `docs/paid-data-sources.md`); **the key
    itself exists only where it was configured** — check Vercel's env, not this repo
  - `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `NEXT_PUBLIC_VAPID_PUBLIC_KEY` — the Web Push
    keypair. **If lost, every existing push subscription is dead** and all standing alerts stop
    delivering silently. Regenerating (`npx web-push generate-vapid-keys`) makes new subs work but
    orphans old ones
  - `SKOPOS_TOKEN_ADDRESS`, `AEON_FORK_REPO`, `RELAY_API_KEY`, `FAST_LLM_MODEL`,
    `SMART_LLM_MODEL`, `A2A_KPI_SEED` — all have sane code defaults
  - `SMART_MONEY_AGENT_DAILY_CAP` — used in `lib/usage.ts`, documented in
    `docs/headless-text-mode.md`, **absent from both `.env.example` and `CLAUDE.md`**
- `node_modules/` — restored; `pnpm install --frozen-lockfile` resolves cleanly (exit 0).
- `.gstack/`, `internal/`, `docs/vara-mvp-prd.md` — gitignored by name, so **local planning/research
  notes existed on the old machine and are not recoverable from git.** The `.gitignore` entries are
  the only proof they were ever there. [Confirmed]

**Deployments and state that live outside this repo entirely:**
- **Vercel project** — holds every production env var. The single most valuable missing artifact;
  everything else can be rebuilt from it.
- **Upstash Redis instance** — holds all live state: Smart-tier counters, subscription grants
  (`sub:<wallet>`), watcher registrations, push subscriptions, and the permanent `kpi:a2a:total`.
  **Not backed up anywhere in this repo.** Losing it silently voids every paid subscription and
  every standing alert.
- **Fly.io app `relay-tranquil-log-8398`** — currently running. Its secrets (`RELAY_MNEMONIC` or
  `RELAY_WALLET_JSON_CONTENT`, `VOUCHER_ID`, `OPERATOR_HEX`, `HERALD_ACCOUNT`) are Fly secrets, not
  in this repo. `relay/scripts/gen-fly-secrets.sh` exists to regenerate them.
- **The Vara relay wallet** — controls `fulfill_request`. Only the relay `ActorId` may call it; if
  the key is lost, `set_relay` must be called by the admin account.
- **The Vara admin account** — the only account that can `set_fee`, `set_relay`, or `withdraw`
  from the bridge program. [Unknown — I could not determine who holds it]
- **`x402/skopos-subscribe/index.ts`** — deployed to Bankr x402 Cloud, **manually**. There is no
  deploy script or CI for it in this repo. [Confirmed]
- **The Aeon fork's GitHub Actions** — lives in `Svector-anu/svectors-lab`. Its cron and whatever
  API keys drive it are not here, and it stopped producing output on 2026-07-28.
- **Delora Partner Portal** — where the integrator fee wallets must be linked (see P5). No API.
- **`Svector-anu/skopos-os`** — a separate public repo the landing page links to. Its relationship
  to this repo (mirror? subset? abandoned?) is **[Unknown]**.

---

## 11. Technical Debt

| Debt | Evidence | Why it matters |
|---|---|---|
| **`app/app/page.tsx` is 5,781 lines** with every card renderer inline and no memoization | issue #26, filed when it was 4,186 lines — it has **grown 38% since** | Every new card type makes it worse; #26 also cites a "40ms re-render storm" |
| **`app/api/chat/route.ts` is 3,428 lines** | read in full | ~50 ordered dispatch blocks in one function. The order is load-bearing and undocumented outside comments — extremely easy to break by inserting a block in the wrong place |
| **Zero tests outside `relay/`** | `find` — only `relay/test/`, `relay/src/__tests__/` | The routing waterfall, the regex parsers, and `cardToText` are exactly the kind of pure logic that should be unit-tested, and none of it is |
| **No CI at all** | no `.github/` directory; issues #78, #49 | Nothing catches the lint errors currently on `main`, nothing runs the relay tests |
| **3 independently-maintained capability lists** | issue #33 | `SKOPOS_HELP` in route.ts, `SKOPOS_CAPABILITIES` in parseIntent.ts, and `SKILL.md` all describe the same product — and have already drifted (see §8.1) |
| **`lib/pay.ts` / `lib/payments.ts` duplicate B20 scaffolding** | issue #35 | Already drifted per the issue |
| **10 eslint-disabled `any` casts in `lib/alchemy.ts`** | issue #40, confirmed by grep | The generic JSON-RPC helper is untyped |
| **Portfolio covers 10 of 25+ supported chains** | issue #34 | Users can sign on chains whose balances Skopos can't read |
| **No workspace boundary** between the app and `relay/` | issue #37 | `relay/`'s native deps (`better-sqlite3`) are one tsconfig edit from breaking the Vercel build. Currently held back only by `"exclude": ["relay"]` in `tsconfig.json` |
| **`@anthropic-ai/sdk` orphan dependency** | §5 Phase 1 | Ships in the lockfile, imported nowhere since 2026-04-14 |
| **Documentation drift** | issue #32, and §12 below | The docs are otherwise excellent, which makes the stale parts more dangerous, not less |

---

## 12. Documentation vs. Reality

The documentation is unusually good — `CLAUDE.md`, `docs/skopos-system.md`, `docs/skopos-core.md`,
`docs/headless-text-mode.md`, `docs/paid-data-sources.md`, and `docs/pyth-integration.md` are all
substantive. But three of them carry their own "last verified" dates that have gone stale.

**Accurate and current** [Confirmed by cross-reading]:
- `docs/headless-text-mode.md` — matches `lib/cardToText.ts` and the live API exactly.
- `docs/paid-data-sources.md` — matches `lib/x402Agent.ts` / `sniperCheck.ts` /
  `holderConcentration.ts`, including the HYRE→Chain Intel swap rationale.
- `CLAUDE.md`'s routing-layer description, chain-map table, and Agent-payable API table.

**Stale or contradicted by the code:**

| Doc claim | Reality |
|---|---|
| `CLAUDE.md`: "All LLM calls use Groq (`llama-3.1-8b-instant`)" | Only the **Fast** tier. **Smart** uses `claude-haiku-4.5` via the Bankr gateway (`lib/parseIntent.ts:311`) — the very next section of the same file describes tiering correctly, so `CLAUDE.md` contradicts itself |
| `CLAUDE.md` + `skopos-system.md`: `redactLiveNumbers` applied to `getGroqInformationalReply` / `getGroqReply`; "not applied to `streamSuggestion` (known gap)" | **All three functions no longer exist.** They were consolidated into `getInformationalReply`; `streamSuggestion` is gone, so **the documented P1 security gap is resolved** and the doc still lists it as open |
| `skopos-system.md` §9 P2: rate limiter | Still true, but now a documented deliberate tradeoff (`lib/rateLimit.ts` header), not an unaddressed bug |
| `skopos-system.md` §9 P3: quote TTL not enforced | Addressed **differently** than the doc proposes — there's no server-side TTL; instead the client re-quotes immediately before signing (`onRevalidate`) and `resolveLeg` refuses REVERTED simulations |
| `skopos-system.md` §11: "`lib/commands.ts` `COMMANDS` array is dead code" | The array was **removed** (`a63ca23`); the file now exports only the `Command` type, which two components do import |
| `skopos-system.md` §3: routing flow (8 special handlers) | Now ~50 blocks. Structurally correct but wildly incomplete |
| `.env.example` + `CLAUDE.md`: `DELORA_INTEGRATOR=ANU` | Code defaults to lowercase `"anu"` since `54fd7d1`. **Copying `.env.example` re-creates the fee-skipping mismatch** |
| `.env.example` | Missing 13 env vars used in code (§10) |
| `CLAUDE.md` env list | Missing 9 env vars, including `SKOPOS_X402_PRIVATE_KEY` and the VAPID keys |
| Mintlify + landing GitHub links → `skopos-os` | Public but ~1 month stale; in-app links → private repo, 404 for users |
| `mintlify-docs/build/agent-skill.mdx` tells users to download `/skopos-skill.md` | That file is the pre-hardening version (§8.1) |

**Implemented but undocumented:** the `x402check` card type; the `/api/stats` KPI endpoint; the
418 teapot easter egg on `GET /api/chat`; `SMART_MONEY_AGENT_DAILY_CAP`; the `MPP_SECRET_KEY`
alternative to CDP credentials that `@agentcash/router` now accepts.

---

## 13. Verification Status

**What I actually ran or probed** (all read-only; no writes, no on-chain calls, no paid x402 calls):

| Check | Result |
|---|---|
| `git status` / branches / remotes | Clean tree, `main` up to date with `origin/main`. Branches `feat/x402-intel` and `vara` are **fully merged** (0 commits ahead) — no lost work on branches [Confirmed] |
| `pnpm install --frozen-lockfile` | **Exit 0.** Lockfile resolves; 10 packages have ignored build scripts (deliberate) |
| `pnpm build` | **Fails before reaching Next** — pnpm 11's dep-status check re-runs install, which exits 1 on ignored builds |
| `./node_modules/.bin/next build` (no env) | **FAILS** — `RouterConfigError` at `/api/flash-order`. TypeScript itself compiled clean in 21s |
| `./node_modules/.bin/next build` (dummy agentcash env) | **SUCCEEDS** — all 39 routes collected. Confirms env config is the *only* build blocker |
| `eslint .` | **2 errors, 3 warnings** (all listed in P8) |
| `relay/` `npm install && npm test` | **59 tests pass** (45 vitest across 5 files + 14 node:test) |
| `GET https://www.tryskopos.xyz/` | 200 |
| `POST /api/chat {"message":"eth price","format":"text"}` | Correct price card + sparkline + chart image URL |
| `POST /api/chat {"message":"swap 1 eth to usdc on base","format":"text"}` | Correct quote summary + sign-in link, **no signable payload** — non-custodial contract holds |
| `POST /api/aeon/read {"kind":"defi"}` | 200, but **"as of 2026-07-28"** — 23 days stale |
| `GET /api/stats` | `{"a2aCallsServed":18432}` |
| `GET /openapi.json` | All 10 paid routes listed, server `https://www.tryskopos.xyz` |
| `GET /llms.txt` | Returns only the one-line guidance string, **no route list** — `/openapi.json` carries the real discovery. [Likely upstream `@agentcash/router` behaviour; unverified] |
| `GET https://relay-tranquil-log-8398.fly.dev/` | `status: running`, **`lastBlock: 0`**, all DB counters 0 |
| `registry.npmjs.org/skopos-mcp` | v0.1.0 published 2026-07-08 [Confirmed] |
| GitHub API on the three referenced repos | `skopos` → 404 (private); `skopos-os` → public, pushed 2026-06-29; `skopos-aeon` → 301 → `svectors-lab`, a fork of `aeonfun/aeon` |
| Aeon fork raw URLs (both old and new repo names) | All 200 — GitHub follows the rename, so the feed is not broken by it |
| `gh issue list` on the private repo | 35 open issues, 0 open PRs |

**What I could NOT verify:**
- Any path requiring a wallet: swap execution, Flash EIP-712 signing, Solana signing, approval
  revocation, the x402 subscription purchase.
- Any path that spends money: all paid Nansen / Chain Intel reads, and every x402-paid route as a
  paying client.
- The Vara on-chain program's actual deployed state, the admin account, or whether the relay wallet
  is still authorised.
- Whether the Vercel cron is actually firing (needs `CRON_SECRET` and Vercel logs).
- Whether the Delora integrator fee is still uncollected (needs the Partner Portal).
- Anything about Vercel env vars, the Upstash instance's contents, or Fly secrets.
- The relationship between this repo and `Svector-anu/skopos-os`.
- Whether the Aeon fork's cron is disabled, erroring, or out of credits.

---

## 14. Next Steps

### Must fix (do these before writing any feature code)

1. **Recover the environment.** Pull the production env from the Vercel project into `.env.local`.
   Confirm `SKOPOS_X402_PRIVATE_KEY`, the VAPID keypair, `CRON_SECRET`, and `RELAY_SECRET` still
   exist somewhere — if the VAPID keys are gone, every standing alert is already silently dead.
   Then **update `.env.example` and `CLAUDE.md` with the 13 / 9 missing vars**, and fix
   `DELORA_INTEGRATOR` to lowercase `anu` in both so nobody re-creates the fee bug (P5).
2. **Sync `public/skopos-skill.md` from `skills/skopos/SKILL.md`.** The publicly-installable skill
   is missing the safety confirmation gate and risk disclosure that the last commit added. One
   `cp`. This is the highest-risk-per-effort item in the repo.
3. **Fix or disclose the stale Aeon feed (P1).** Either restart the fork's cron in
   `Svector-anu/svectors-lab`, or make `lib/aeonFeed.ts` refuse to serve a read older than N days
   and say so plainly, rather than presenting a month-old "Conviction: high" market call as today's.
4. **Fix the in-app GitHub links (P2).** Point them at `skopos-os` (and refresh that mirror), or at
   a public issue tracker — currently "report a bug" is a 404.
5. **Diagnose the relay (P3).** Check Fly logs for `lastBlock: 0`. Independently: add a `[mounts]`
   volume to `relay/fly.toml`, or stop claiming crash-recovery in the docs — right now the SQLite
   safety net is destroyed on every restart.

### Should fix

6. **Close the signing-surface gap (P5b / issue #83)** — assert Flash's `orderTypedData` against
   the quoted intent server-side, and surface the approval spender / target contract on the quote
   card. The typed-data assertion is a small, self-contained change in `resolveFlashOrderLeg()` /
   `resolveFlashLeg()` and is the highest-value security work available. Router pinning can follow
   after a week of logging.
7. **Add CI** (issue #78) — the cheapest possible version: `tsc --noEmit`, `eslint`, `relay` tests,
   and a `next build` with dummy agentcash env, on every push. This repo has gone 4 months with
   nothing catching regressions.
8. **Clear the lint errors on `main`** (P8) — 2 errors, one of which (`Cannot access refs during
   render`) is a real React correctness bug, not style.
9. **Triage the issue tracker.** At least #27, #31, and part of #47 are already done. A stale
   tracker is worse than none.
10. **Reconcile the doc drift in §12** — especially removing the resolved `streamSuggestion` P1 from
   `docs/skopos-system.md` (it advertises a security gap that no longer exists) and fixing
   `CLAUDE.md`'s self-contradiction about Groq being the only LLM.
11. **Instrument the A2A counter** (P4) so broadcaster traffic and genuine third-party calls are
    counted separately, before that number is used anywhere externally.
12. **Split `app/app/page.tsx`** (issue #26). Start by extracting the ~20 `*Display` card
    components into `components/cards/` — mechanical, low-risk, and unblocks memoization work.
13. **Write the first tests for the main app.** `classifyIntent`, `regexParse`,
    `parseFlashOrderIntent`, and `cardToText` are pure functions with high blast radius. The relay
    already has a working vitest setup to copy.

### Nice to have

14. Finish the Li.Fi spike in `lib/delora.ts:54` and close issue #82.
15. Headless handoff for advanced orders (#80).
16. Live-verify the three "compile-verified only" x402 client paths — the subscription purchase is
    a revenue path that has never been proven end to end.
17. Remove `@anthropic-ai/sdk`.
18. Back up the Upstash keyspace, or at minimum the `sub:*` subscription grants.
19. Richer onchain watcher (#75); more portfolio chains (#34).

---

## 15. Agent Operating Context

**Read this before changing anything.**

### Invariants that must not break

1. **Non-custodial is absolute.** No server-side signing. No private key ever reaches a browser.
   The one server-held key (`SKOPOS_X402_PRIVATE_KEY`) pays for *data*, never moves user funds.
   Headless clients get a **link**, never a signable payload — `/api/quote` and every text-mode
   execute intent depend on this. Do not "helpfully" return calldata to an agent.
2. **A tool always beats the LLM.** If a tool can answer, call the tool. The LLM never produces a
   price, APY, TVL, balance, or gas figure. `redactLiveNumbers()` is the last line of defence, and
   it is bypassed **only** in grounded mode where real numbers were deliberately supplied.
3. **`classifyIntent()` and `regexParse()` are pure regex. Never add an LLM call to them.**
4. **The dispatch order in `handleChat()` is load-bearing.** Nearly every block sits where it does
   because of a specific misrouting bug — the guided buy/sell before the price fast-path, the
   approval scanner before portfolio, the missing-source guard before `parseIntent`, the
   dollar-amount guard before `parseIntent`, `META_RE` before any LLM path, the harmful-content
   boundary before *everything*. **Adding a block in the wrong position silently breaks unrelated
   queries.** Read the surrounding comments; they explain why.
5. **Never duplicate a `lib/` function for a paid route.** Every x402 route reuses the exact
   function its free chat equivalent calls. That rule is what keeps the two surfaces from drifting.
6. **Adding a chain means updating all five maps** (§3.4) — `CHAIN_IDS`, `SUPPORTED_CHAINS`,
   `EXPLORER_URLS` (keyed by **name**), and one of `ALCHEMY_CHAINS`/`BLOCKSCOUT_CHAINS`.
7. **Fail-open vs fail-closed is a deliberate, per-module decision.** `checkSmartQuota` and
   `checkAgentSmartBudget` fail **open** (availability wins). `checkIntelBudget`,
   `checkAgentTextIntelCap`, `isEntitled`, `/api/cron/watchers`, and `/api/vara` fail **closed**
   (anything that spends real money or grants access must not be enabled by an outage). Read the
   comment before changing a `return true` to a `return false` or vice versa.
8. **CSS: card components must use the `--card-*` variables from `globals.css`.** Never hardcode
   `rgba(255,255,255,…)`. SVGs need the React `style` prop — presentation attributes don't resolve
   CSS variables.
9. **Prompt builders live in `route.ts`; the Groq/gateway calls live in `lib/parseIntent.ts`.**
   Keep that split.
10. **Externally-sourced strings are hostile.** Token names, ENS labels, pool names, market titles,
    and payment memos are attacker-chosen. `sanitizeForPrompt()` before an LLM prompt;
    `lib/cardToText.ts`'s sanitiser before an agent-facing text reply. Both exist because of real
    prompt-injection fixes (`f6c8803`, `fd97277`).

### Dangerous areas

- **`app/api/chat/route.ts`** — one 3,428-line file, no tests, ordering-sensitive. Highest blast
  radius in the repo.
- **`app/app/page.tsx`** — 5,781 lines, all wallet state and every signing path. Per the user's own
  standing rule: **do not make direct edits to visual/styling code**; logic changes are fine.
- **`lib/agentcashRouter.ts`** — throws at module load. Touching its config breaks `next build`
  for everyone, immediately.
- **`gear-bridge/`** — a deployed on-chain program. Changing it means a redeploy and a new program
  ID, which invalidates `AGENT_PROGRAM_HEX` / `BRIDGE_PROGRAM_ID` in Fly and the address shown on
  `/vara`. It also uses `static mut STATE` (standard for Gear, but `unsafe`).
- **Anything that spends the agent wallet** — `lib/smartMoneyServer.ts`, `lib/sniperCheck.ts`,
  `lib/holderConcentration.ts`, and the inline intel execution inside `lib/cardToText.ts`. Every
  call is real USDC. Test against the caps, not the wallet.
- **The two "relay"s** (P7). Check which one you're in before touching a `RELAY_*` variable.

### Conventions

- Commits: `type(scope): what changed and why`, lowercase, no trailing period, human-sounding. The
  history is unusually consistent — match it.
- Comments explain **why**, and record live-verification facts with dates
  ("confirmed live 2026-07-15", "verified via prod quote probe"). This is the single most valuable
  property of the codebase. **Preserve it — when you verify something against a live API, write the
  date and the result into the comment.**
- Docs to update when things change: `docs/skopos-system.md` (architecture),
  `docs/headless-text-mode.md` (card types / text projection), `docs/paid-data-sources.md` (any new
  endpoint Skopos pays for), `lib/changelog.ts` (public changelog — the page renders this array,
  `CHANGELOG.md` is the separate technical log), and the SKILL/MCP capability lists.
- No `as any`, no `@ts-ignore`. The existing five instances and ten eslint-disables in
  `lib/alchemy.ts` are pre-existing debt (issue #40), not licence for more.
- **Verification before completion:** this project has no test suite for the app. "It compiles" is
  not evidence. Run `./node_modules/.bin/next build` with the agentcash env set, run `eslint`, and
  where the change touches routing, probe the live/dev endpoint with a real message.
