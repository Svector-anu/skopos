# Paid data sources — Skopos as an x402 client

This catalogs every external, paid endpoint **Skopos itself pays for** — the opposite
direction from `docs/skopos-system.md`'s "Agent-payable API" (where *other* agents
pay *Skopos*). Every entry here is Skopos's own agent wallet paying a third party so
a user (or a headless client) gets an answer with no wallet, no signature, no cost
to them.

**Shared plumbing:** `lib/x402Agent.ts` — one signer/payment-client setup
(`SKOPOS_X402_PRIVATE_KEY`, Base network, USDC-only, EIP-3009 gasless-for-payer). Every
source below calls `getAgentPayFetch()` from that file rather than re-deriving its own
account/signer. **Do not duplicate the x402 client setup per source — extend this
file's pattern instead.**

Wallet address (public, safe to reference): `0x6A1Ea639deEc4C42fbAd0A0b53b1b6Aa6CFE3658`.
Needs USDC on Base to keep working; if a source in this list starts failing, check
that balance first before assuming the upstream is down.

---

## Live sources

### Nansen Token God Mode (smart-money / whale activity)
- **File:** `lib/smartMoneyServer.ts`
- **Endpoint family:** `https://api.nansen.ai/api/v1/tgm/*`, `token-screener`
- **Price:** ~$0.01/call typical, up to ~$0.05 observed for at least one call
  pattern (verified on-chain 2026-07-10 — 18 of 19 real settlements were $0.01,
  one was $0.05). Skopos's own paid endpoint `/api/smart-money` is priced at
  $0.05 specifically to stay profitable against the worst observed case, not
  just the average.
- **Feeds:** free chat commands ("who is buying $X", "smart money buying",
  "who holds $X"), the paid `/api/smart-money` x402 endpoint, and (via
  `fetchHoldersServer()`) the holder-concentration half of `/api/sniper-check`
  — see the holder concentration entry below.
- **Gate:** `agentPaidEnabled()` (re-exported from `lib/x402Agent.ts` via
  `lib/smartMoneyServer.ts` for backward compatibility with existing imports).

### Robinhood Chain Launch Intelligence
- **File:** `lib/robinhoodLaunches.ts`
- **Endpoint:** `GET https://robinhood-launches.hustlerhigher.workers.dev/recent-robinhood-launches`
  (a single independent developer's Cloudflare Worker, discovered via x402scan,
  not an established platform — treat as less reliable than Nansen)
- **Price:** $0.001/call (`limit`, `onlyAttributed` query params)
- **Feeds:** the "robinhood chain launches" / "what's launching on robinhood"
  chat command (`app/api/chat/route.ts`).
- **Known limitation (as of 2026-07-11):** DexScreener has not indexed
  Robinhood Chain (chainId 4663) — every `scanToken` lookup on a Robinhood
  Chain address returns `pairs:null`. There is currently no way to cross-check
  a launch for honeypot/liquidity risk; the only signal surfaced is the
  creator wallet's repeat-launch count from the feed's own data
  (`creator.launchesInCurrentBankrFeed`). Revisit once an aggregator covers
  this chain — see `lib/dexscreener.ts`'s `scanToken` for where a real cross-
  check would plug in.
- **Reliability note:** single-developer endpoint, could change price/shape/
  disappear without notice, unlike Nansen. If it starts 404ing or timing out,
  that's the most likely explanation — not a Skopos-side bug.

### HYRE Agent (sniper detection)
- **File:** `lib/sniperCheck.ts`
- **Endpoint:** `GET https://mpp.hyreagent.fun/base/trenches/token/{mint}/snipers`
- **Price:** $0.04/call (confirmed live via a real 402 challenge on 2026-07-15;
  full paid response not observed — the settlement itself wasn't tested)
- **Feeds:** `/api/sniper-check` (`app/api/sniper-check/route.ts`)
- **Trust tier:** `origin_hosted` (real OpenAPI spec, agentcash-verified)
- **Known limitation:** HYRE also serves Solana (root paths) and SKALE
  (`/skale/*`) sniper endpoints at the same $0.04, but `lib/x402Agent.ts`'s
  signer only registers the Base network (`eip155:8453`) — no Solana keypair,
  no SKALE registration. Worse, a live test against the SKALE endpoint with
  CASHCAT (`0x020bfc650a365f8bb26819deaabf3e21291018b4`) returned a 402
  challenge that failed to parse (`parse_payment_required`) — the challenge
  itself isn't spec-conformant, not just an auth gap on our side. Both chains
  are deferred: Solana needs a whole new signer (SVM keypair + a Solana x402
  scheme), SKALE needs the upstream challenge fixed or a documented workaround
  found first.

### Holder concentration — Nansen `tgm/holders`, not x402 Trading Hub
- **File:** `lib/holderConcentration.ts`
- **Endpoint family:** `https://api.nansen.ai/api/v1/tgm/holders` via
  `fetchHoldersServer()` (`lib/smartMoneyServer.ts`) — the exact same call the
  free "who holds $X" chat command and `/api/intel/holders` already use, not a
  new integration.
- **Price:** ~$0.01–0.05/call, same Nansen TGM economics documented above.
- **Feeds:** `/api/sniper-check` (`app/api/sniper-check/route.ts`).
- **Method:** sums `ownership_percentage` (Nansen's own per-wallet supply
  share, already computed against real supply) across the top 10 rows by
  `value_usd`. Deliberately not `value_usd ÷ scanToken()`'s market cap — that
  would reconstruct a percentage from two independently-sourced numbers
  (Nansen's $ value, DexScreener's market cap) that can disagree on
  methodology (FDV vs. circulating) or staleness; `ownership_percentage` is
  the more accurate number Nansen already hands back in the same response.
- **Superseded source — x402 Trading Hub (`x402-trading-hub-v2.vercel.app`):**
  originally speced for this, but confirmed dead 2026-07-15 — both the target
  endpoint and the bare origin root return `404 DEPLOYMENT_NOT_FOUND` straight
  from Vercel's edge (the deployment no longer exists), confirmed with a
  live-funded call from Skopos's own production wallet before any x402
  challenge would have fired. agentcash's `discover_api_endpoints` still lists
  this origin with live pricing — that's a stale scan cache, not current
  reality; don't trust it for this origin without re-checking.

---

## Adding a new source

1. Confirm the endpoint's real price by making one live test call (via the
   `agentcash` MCP tool or equivalent) before wiring it into Skopos — don't
   trust an announcement/tweet's stated price as ground truth.
2. Import `getAgentPayFetch`/`agentPaidEnabled` from `lib/x402Agent.ts`. Don't
   write a new signer/client setup.
3. If Skopos will also resell this as one of its own paid x402 endpoints
   (`docs/skopos-system.md`'s Agent-payable API), price it with a real margin
   over the *worst* observed upstream cost, not the average — see the Nansen
   entry above for why.
4. Add an entry to this file: file, endpoint, price, what feeds from it, and
   any known limitation (missing cross-checks, upstream reliability, etc.).
