# Changelog

All notable changes to this project will be documented in this file.

---

## [Unreleased]

### Added
- **B20 memo payments** — a `pay` intent and payment card. `pay 10 USDC to 0x… for invoice-42 on base` builds a transfer the user signs client-side (non-custodial). On a Base **B20** token it uses `transferWithMemo`, so the payment carries a machine-reconcilable reference (invoice/order id) on-chain via the `Memo` event; on a plain ERC-20 it falls back to `transfer()` and notes the memo was skipped. Resolves tokens by symbol or address (verified known map + Delora's global list), auto-detects B20 by the deterministic `0xb200…` prefix. Base + Base Sepolia.
- **`$skopos` holder gate** (`lib/tokenGate.ts`) — holding `$skopos` raises a wallet's Smart daily cap through ascending env-configured tiers. Keyless Base RPC balance read, 5-min cache, fails to the free cap on any error. Disabled by default (`SMART_TOKEN_GATE_MIN` unset).
- **Deterministic help/identity card** — "what is skopos / what can you do / help" answer from a fixed capabilities response (zero LLM), so the product can never misdescribe itself.
- **Base Sepolia (84532)** added to the wallet config so B20 payments are testnet-testable.
- `.agent/wallets.json` — Zetta agent wallet manifest (agent financial-identity registry).
- `docs/skopos-core.md` — comprehensive system architecture reference covering routing logic, execution engines (Delora, Polymarket, DeFiLlama, Groq), data sources, wallet auth layer, environment variables, and file map. Single source of truth for contributors and AI agents working on the codebase.
- `/api/vara` relay endpoint — Vara Network bridge handler supporting 6 query types: `price` (CoinGecko), `risk` (DexScreener), `yield` (DeFiLlama), `markets` (Polymarket), `quote` (Delora), `portfolio` (Alchemy). Secured with Bearer token auth.
- `relay/` — off-chain relay service for the Vara × Skopos bridge. Listens for `BridgeEvent::RequestPending` on Vara testnet, dispatches to `/api/vara`, and submits `fulfill_request` on-chain. SQLite persistence for crash recovery. Kill-9 safe: recovers in-flight requests on restart using `queryPending` to avoid double-spend.

### Changed
- Chat replies no longer deny Skopos's own capabilities. The informational prompts (Fast, Smart, grounded) share one source-of-truth capability block and describe real execution (swap/bridge/rebalance/pay) truthfully; live-data questions route to the command that pulls them instead of dead-ending.
- Not-live features (DCA/recurring, limit/conditional orders, fiat off-ramp, MCP, whale tracking) return an honest "not live yet" instead of being mis-parsed.
- Yield scanner respects the requested chain (`base eth yield` returns Base pools, not cross-chain).
- Composer "horizon" chips tag not-live features with `· soon`; the working ones (polymarket, yield scanner) lead.

### Fixed
- Execution safety — re-simulate right before signing (single-leg, **rebalance legs**, and Solana), reject routes that would revert, surface failed-tx state, and guard Solana signing against a switched wallet account.
- Ghost session — surface `logout()` failures instead of swallowing them.
- Rebalance — `split 1 ETH across base and arbitrum` now divides the amount across legs and prompts for the source chain instead of a cryptic error.
- Payments — `pay … to 0x…` no longer gets hijacked by the wallet-lookup layer, and a malformed recipient gives a clear error.

---

Want a deeper walkthrough of any of this — the routing waterfall, the B20 payment flow, the agentic-payments direction? Reach out on X [@tryskopos](https://x.com/tryskopos). Happy to go deep.
