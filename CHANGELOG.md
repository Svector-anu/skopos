# Changelog

All notable changes to this project will be documented in this file.

---

## [Unreleased]

### Added
- **Flash advanced orders on Robinhood Chain** — limit, stop-loss, take-profit, and TWAP, all live via natural language (`buy $2000 of ETH at $1800`, `sell 2 ETH if it drops below $2000`, `sell 2 ETH when it hits $5000`, `buy $500 of ETH over 7 days`). Same quote → EIP-712 sign → submit flow as a market order — no new signing UX, just the trigger/schedule shown clearly on the card before you sign. Missing amount, price, or duration prompts conversationally instead of guessing a number.
- **Relay bridging onto/off Robinhood Chain** — `bridge 0.1 ETH from base to robinhood` and the reverse, both directions live-confirmed. Fills a real gap: Delora doesn't support chain 4663 at all, and Flash's own API rejects cross-chain quotes outright, so this was the only way to get funds on or off the chain before trading.
- **Flash market swaps on Robinhood Chain — native execution** — same-chain swaps (`swap 0.01 USDG to ETH on robinhood`) settle through Definitive's Flash API, the execution layer Delora doesn't cover for chain 4663. EIP-712 signing client-side, server-mediated submit (Flash's API key never reaches the browser), automatic WETH wrap step when the trade spends native ETH.
- **Sniper detection + holder concentration** (`/api/sniper-check`, x402 $0.25) — bundle detection (≥3 early buyers sharing one transaction hash — one bot, several wallets, same block) via x402 Chain Intel on Base, holder concentration via Nansen. Solana and Robinhood Chain (SKALE) are still blocked upstream — no Solana signer, SKALE's challenge fails schema validation — and priced/documented accordingly rather than oversold.
- **Pre-buy research bundle** — `should I buy X` / `research X before I buy` returns one card bundling price + risk, smart-money flow (where a Nansen chain slug resolves), and a same-chain swap quote, run in parallel.
- **Robinhood Chain launch feed** — `what's launching on robinhood chain` returns a real card: colored risk badge leading every entry, liquidity color-coded (red ≤$5K, green >$50K), deployer handle and repeat-launch warning both linking to the live-verified noxa.fun profile (every token a wallet has launched) and per-token page, plus the upstream feed's Bankr terminal discover link. Honest about scope — the chain launches a token every 1–2 minutes, so "25 most recent" only ever spans about half an hour; no fake "past week" filtering pretending otherwise.
- **Mintlify docs site** (docs.tryskopos.xyz) — 21 pages across 4 nav groups, replacing the old in-app `/docs` page.
- **x402 payment UX fallback (swap-to-cover)** — when a connected wallet is short on Base USDC for a paid x402 endpoint, quotes a same-chain ETH→USDC swap through the same pipeline every other swap uses, shows the combined cost (payment + swap fee) upfront, and signs non-custodially like any other swap. No ETH to swap either → falls back to the existing Fund Wallet prompt.
- `docs/paid-data-sources.md` — catalogs every external x402 endpoint Skopos itself pays as a client (Nansen, chain-intel, etc.) — the opposite direction from the agent-payable API it exposes to others.
- **DAO treasury lookup** — `treasury of uniswap` returns a live, multi-chain treasury value computed on the spot from real on-chain holdings, reusing the existing multi-chain address scanner against a small hand-verified DAO address map (Uniswap, ENS, Arbitrum today).
- **Standing alerts** — `alert me when eth hits $5000`, `monitor polymarket trump 2028`, `watch 0x… for activity`. Three watch types (price one-shot; Polymarket volume moves and on-chain wallet activity, both recurring), delivered via Web Push, evaluated on a daily cron.
- **Token pick + picks tracker, now on Aeon's real skill** — the daily pick and its scorecard run on Aeon's own 7-day-dedup, 0–10-signal-scored engine (HIGH/MEDIUM/SKIP conviction, honest skip when nothing clears the bar), replacing the earlier first-candidate-that-clears-a-bar version.
- **Two more Aeon reads** — `fear and greed divergence` (assets holding up while the market's scared, or an honest "nothing today") and `x402 pulse` (weekly adoption tracker for the agentic-payments protocol Skopos itself settles through).
- **Agent-payable API** (`lib/agentcashRouter.ts`) — 8 x402-priced, agent-discoverable endpoints (price/quote/risk/smart-money/yield/polymarket/market-read/treasury), listed on x402scan. Every paid route reuses the exact `lib/` function its free chat command already calls, so pricing a route never means a second implementation to keep in sync. Discovery via `/openapi.json` and `/llms.txt`.
- **Generic x402 client** — `check <url>` on any x402-paywalled endpoint (not just ones Skopos already knows about) discovers the price via a free, SSRF-guarded probe, then lets your own connected wallet pay for it directly if you want to proceed.
- **Aeon market reads via a self-hosted fork** (`lib/aeonFeed.ts`) — `defi read`, `what's the narrative`, `what's trending`, and `top DeFi protocols` are served from a public GitHub Actions fork of Aeon (`Svector-anu/skopos-aeon`) that runs the skills on a cron and commits the output. Skopos fetches the raw file, caches in-memory (15 min), and projects to concise text. Cache-first, so the reads are instant on web **and** headless (iMessage/Telegram); the Bankr Agent API stays a fallback. Trending + top-protocols are harvested for free from the same `market-context.md` the DeFi cron already produces.
- **Multi-chain tx-safety flags** — the tx read (`lib/alchemy.ts`) decodes `approve(spender, amount)` and prepends a ⚠️ warning when the allowance is effectively unlimited (`>= 2^255`), the classic wallet-drainer vector. Works across all 10 chains `lookupTx` already searches (Ethereum, Base, Arbitrum, Optimism, Polygon, BSC, Avalanche, zkSync, Linea, Gnosis).
- **Honeypot detection** — the token scanner (`lib/dexscreener.ts`) flags `POSSIBLE_HONEYPOT` (≥5 buys, zero sells over 24h) as CRITICAL regardless of liquidity; headless now renders every risk flag in plain English instead of raw slugs.
- **Chart PNG route** (`/api/og/chart`) — an OG-style 1200×630 price chart rendered from a token's 7d sparkline (self-contained, re-fetches its own data). Text-mode `price` replies carry an `image` url so headless clients (iMessage) render a real chart; opt out of the ASCII sparkline with `sparkline: false`.
- **B20 memo payments** — a `pay` intent and payment card. `pay 10 USDC to 0x… for invoice-42 on base` builds a transfer the user signs client-side (non-custodial). On a Base **B20** token it uses `transferWithMemo`, so the payment carries a machine-reconcilable reference (invoice/order id) on-chain via the `Memo` event; on a plain ERC-20 it falls back to `transfer()` and notes the memo was skipped. Resolves tokens by symbol or address (verified known map + Delora's global list), auto-detects B20 by the deterministic `0xb200…` prefix. Base + Base Sepolia.
- **`$skopos` holder gate** (`lib/tokenGate.ts`) — holding `$skopos` raises a wallet's Smart daily cap through ascending env-configured tiers. Keyless Base RPC balance read, 5-min cache, fails to the free cap on any error. Disabled by default (`SMART_TOKEN_GATE_MIN` unset).
- **Deterministic help/identity card** — "what is skopos / what can you do / help" answer from a fixed capabilities response (zero LLM), so the product can never misdescribe itself.
- **Base Sepolia (84532)** added to the wallet config so B20 payments are testnet-testable.
- `.agent/wallets.json` — Zetta agent wallet manifest (agent financial-identity registry).
- `docs/skopos-core.md` — comprehensive system architecture reference covering routing logic, execution engines (Delora, Polymarket, DeFiLlama, Groq), data sources, wallet auth layer, environment variables, and file map. Single source of truth for contributors and AI agents working on the codebase.
- `/api/vara` relay endpoint — Vara Network bridge handler supporting 6 query types: `price` (CoinGecko), `risk` (DexScreener), `yield` (DeFiLlama), `markets` (Polymarket), `quote` (Delora), `portfolio` (Alchemy). Secured with Bearer token auth.
- `relay/` — off-chain relay service for the Vara × Skopos bridge. Listens for `BridgeEvent::RequestPending` on Vara testnet, dispatches to `/api/vara`, and submits `fulfill_request` on-chain. SQLite persistence for crash recovery. Kill-9 safe: recovers in-flight requests on restart using `queryPending` to avoid double-spend.

### Changed
- Aeon narrative/DeFi reads no longer need the Bankr Agent API at request time — they're served **cache-first** from the self-hosted fork, so they're instant and cost nothing per request (the paid inference runs on the fork's own cron). The Bankr Agent path remains a fallback.
- Chat replies no longer deny Skopos's own capabilities. The informational prompts (Fast, Smart, grounded) share one source-of-truth capability block and describe real execution (swap/bridge/rebalance/pay) truthfully; live-data questions route to the command that pulls them instead of dead-ending.
- Not-live features (perpetual/recurring DCA agents, fiat off-ramp, whale tracking) return an honest "not live yet" instead of being mis-parsed. Limit/stop-loss/take-profit/TWAP orders were on this list — they shipped (see Added, above) and were removed from it.
- Yield scanner respects the requested chain (`base eth yield` returns Base pools, not cross-chain).
- Composer "horizon" chips tag not-live features with `· soon`; the working ones (polymarket, yield scanner) lead.

### Fixed
- x402 client — only the v2 Base payment scheme was registered, so any seller still issuing legacy v1 challenges failed client-side (`no client registered for x402 version: 1`) before any payment was attempted. This was silently the reason sniper detection had been returning null since it shipped. v1 support added alongside v2.
- Agent-paid intel routes — rate limiting + CORS added across all 5 (smart-money/holders/flows/flow-intel/screener), one shared 5/min bucket so rotating between endpoints can't multiply the allowance.
- "Read Docs" button pointed at the old internal `/docs` page, never updated after docs.tryskopos.xyz went live — now points to the real site.
- Chat no longer falsely tells users MCP "isn't live" — it's a real, published npm package (`skopos-mcp`), actively promoted on the docs site.
- Robinhood Chain launch feed disclaimer now explicitly warns that launched token names can impersonate real people or brands with zero affiliation (a user mistook a permissionless launch for the real person it referenced), not just flag repeat-launch count.
- Token pick — a "want a deeper report?" follow-up message was being captured and shown instead of the actual daily pick.
- Smart quotes — apostrophe-tolerant triggers (`what's trending`, `how's defi`) now normalize curly quotes from mac/iOS autocorrect before matching, instead of silently falling through to the generic reply.
- Execution safety — re-simulate right before signing (single-leg, **rebalance legs**, and Solana), reject routes that would revert, surface failed-tx state, and guard Solana signing against a switched wallet account.
- Ghost session — surface `logout()` failures instead of swallowing them.
- Rebalance — `split 1 ETH across base and arbitrum` now divides the amount across legs and prompts for the source chain instead of a cryptic error.
- Payments — `pay … to 0x…` no longer gets hijacked by the wallet-lookup layer, and a malformed recipient gives a clear error.

---

Want a deeper walkthrough of any of this — the routing waterfall, the B20 payment flow, the agentic-payments direction? Reach out on X [@tryskopos](https://x.com/tryskopos). Happy to go deep.
