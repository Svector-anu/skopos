# Changelog

All notable changes to this project will be documented in this file.

---

## [Unreleased]

### Added
- `docs/skopos-core.md` — comprehensive system architecture reference covering routing logic, execution engines (Delora, Polymarket, DeFiLlama, Groq), data sources, wallet auth layer, environment variables, and file map. Single source of truth for contributors and AI agents working on the codebase.
- `/api/vara` relay endpoint — Vara Network bridge handler supporting 6 query types: `price` (CoinGecko), `risk` (DexScreener), `yield` (DeFiLlama), `markets` (Polymarket), `quote` (Delora), `portfolio` (Alchemy). Secured with Bearer token auth.
- `relay/` — off-chain relay service for the Vara × Skopos bridge. Listens for `BridgeEvent::RequestPending` on Vara testnet, dispatches to `/api/vara`, and submits `fulfill_request` on-chain. SQLite persistence for crash recovery. Kill-9 safe: recovers in-flight requests on restart using `queryPending` to avoid double-spend.
