# Task Plan: Ship All Listed Gaps

## Goal
Implement every listed gap from the product audit, in priority order.

## Phases

### Batch A — Trivial (< 5 min each)
- [x] Phase A1: Fix wrong feedback repo link (Svector-anu → correct repo)
- [x] Phase A2: Mobile sidebar close-on-select

### Batch B — Low effort, high impact
- [ ] Phase B1: Fund Wallet button (wire useFundWallet)
- [ ] Phase B2: Live balance in sidebar + loading spinner
- [ ] Phase B3: Theme CSS global fix (data-theme wired properly)
- [ ] Phase B4: Quote TTL server enforcement

### Batch C — Medium effort
- [ ] Phase C1: Rate limiting on API routes
- [ ] Phase C2: Agent mode (multi-step autonomous routing)
- [ ] Phase C3: Limit orders (UI + stub routing)
- [ ] Phase C4: Horizon pills (implement or properly stub each)

### Batch D — Requires external deps (flag + scaffold)
- [ ] Phase D1: Phantom wallet adapter + Solana support
- [ ] Phase D2: Mayan bridge integration for Solana routes
- [ ] Phase D3: SPL token handling

## Key Decisions
- Feedback repo link: use Svector-anu/skopos (current actual repo)
- Rate limiting: in-memory per-IP with sliding window (no Redis dep)
- Quote TTL: add `quotedAt` timestamp to quote response, reject executes > 60s old server-side
- Agent mode: multi-step planner that chains intent parse → quote → present each step
- Limit orders: UI + parseIntent support; backend stub (no live protocol yet)
- Solana: add @solana/wallet-adapter deps, scaffold Phantom connect, Mayan quote path

## Status
**Currently in Phase A** — executing trivial fixes
