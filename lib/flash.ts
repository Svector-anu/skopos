import { fetchWithTimeout } from "./http";
import { getRedis } from "./redis";
import type { DexPair } from "./dexscreener";
import type { FlashOrderStatus, FlashOrderType, FlashPriceTrigger, FlashUpdateRequest } from "./flashUpdate";
import type { FlashBracketWire, AttachedBracketRead } from "./flashBracket";

// The pure half lives in ./flashUpdate so the browser can build and sign an
// update message without pulling this module's server deps into the bundle.
// Re-exported here so every existing server-side import of lib/flash keeps
// working unchanged.
export * from "./flashUpdate";
export * from "./flashBracket";

const BASE = "https://api.dexscreener.com";
const ROBINHOOD_CHAIN_ID = "robinhood"; // DexScreener's chainId slug for chain 4663
const MIN_LIQUIDITY_USD = 1000;
const CACHE_TTL_SECONDS = 24 * 60 * 60;

// Robinhood Chain canonical tokens — USDG is the chain's stablecoin, not USDC.
// DexScreener confirmed zero USDC pairs for Robinhood Chain tokens (checked
// CASHCAT's full 30-pair list, 2026-07-15); USDG (Paxos's Global Dollar) is
// the real liquid quote asset chain-wide ($4.2M+ liquidity in its own
// WETH/ETH pairs, vs. no USDC presence at all). Anyone asking for "USDC on
// Robinhood" — or nothing at all ("just buy X on Robinhood") — almost
// certainly means the chain's actual stablecoin, so resolution silently
// substitutes rather than fail to resolve a token that doesn't meaningfully
// trade here. A future caller wiring the "no contra asset specified" default
// (route.ts, not yet built) should use RH_CHAIN_STABLECOIN directly rather
// than resolving "USDC" through this alias.
export const RH_CHAIN_STABLECOIN = "USDG";
const RH_SYMBOL_ALIASES: Record<string, string> = {
  USDC: RH_CHAIN_STABLECOIN,
};

// Native ETH is never a DexScreener baseToken result — confirmed live
// (2026-07-15): a bare "ETH" search returns zero Robinhood Chain pairs at
// all, since ETH only ever shows up as the *quote* side (e.g. CASHCAT/ETH).
// Same structural problem as USDC, different fix: this maps straight to
// Flash's native-asset sentinel address (its own QuoteRequest examples use
// this exact value) rather than through another DexScreener search.
const NATIVE_ETH_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
// USDG (Global Dollar, Paxos) is Robinhood Chain's own stablecoin — same
// impersonation risk as the stock tokens below, confirmed live: a
// DexScreener symbol search for "USDG" returns 22 Robinhood-chain pairs, and
// an unrelated memecoin ("Useless Stupid Degen Gamblers", priced ~$0.0000291)
// clears the MIN_LIQUIDITY_USD floor and sorts ahead of the real Global
// Dollar token (~$1.00, $3.4M+ liquidity across its own pairs) in
// DexScreener's response order — resolveRobinhoodToken() would silently
// quote against the impersonator. Address cross-checked two ways: DexScreener
// shows this exact address across 6+ high-liquidity pairs all priced
// ~$1.00-$1.003, and Robinhood Chain's own block explorer independently
// confirms it as "Global Dollar" / "USDG" (2026-07-20).
const RH_USDG_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
// $SKOPOS on Robinhood Chain — our own token, address supplied by the owner
// and cross-checked on DexScreener (2026-07-21): primary pool is
// SKOPOS/NVDA, quote side matching the registry-verified NVDA address in
// RH_STOCK_TOKENS. Pinned for the same reason USDG is: ticker impersonation
// is rampant on this chain, and a DexScreener symbol search could resolve
// "SKOPOS" to a copycat. Distinct from the Base $skopos
// (SKOPOS_TOKEN_ADDRESS, holder gating) — different chain, different token.
const RH_SKOPOS_ADDRESS = "0xdcECe5c95adaBcd1cDB48b167a5758a440459Ba3";
const RH_ADDRESS_ALIASES: Record<string, string> = {
  ETH: NATIVE_ETH_SENTINEL,
  WETH: NATIVE_ETH_SENTINEL,
  USDG: RH_USDG_ADDRESS,
  SKOPOS: RH_SKOPOS_ADDRESS,
};

// Robinhood Chain's canonical L2 WETH, from
// https://docs.robinhood.com/chain/protocol-contracts ("L2 Weth", Mainnet).
// Verified live (2026-07-17): quoting with NATIVE_ETH_SENTINEL as contraAsset
// already returns an orderTypedData whose message.fromToken is this exact
// address — Flash's signed order never references the sentinel. The actual
// bug this constant fixes lives one level up, in resolveFlashLeg() (route.ts):
// the *quote request's* contraAsset (the sentinel) was also being echoed
// into the *submit request's* top-level contraAsset field, which Flash
// rejects at /order with NATIVE_ASSET_NOT_SUBMITTABLE — "submit with the
// wrapped asset the quote was priced against" — even though the signature
// itself was always correct. Confirmed live both ways: submitting with the
// sentinel here reproduces that exact rejection; submitting with this
// address instead (same quote, same signature, nothing else changed) clears
// it and progresses to the expected balance check.
export const RH_CHAIN_WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

// Canonical Robinhood Chain stock/ETF token addresses — source of truth is
// Robinhood's own registry at https://docs.robinhood.com/chain/contracts,
// NOT DexScreener search. This distinction matters: DexScreener indexes
// every same-symbol token on the chain, official or not, and confirmed live
// (2026-07-17) there is heavy impersonation activity around every one of
// these tickers (copycat "AAPL"/"TSLA"/etc. tokens, some with tens of
// thousands of dollars of their own liquidity). The registry page itself
// warns of exactly this: "a token with a matching name/ticker but a
// different contract address is not a Robinhood Stock Token." All 25
// addresses below were cross-checked against the page directly, not
// transcribed from a prior DexScreener resolution.
//
// Checked first in resolveRobinhoodToken() (below), before DexScreener —
// see that function's comment for why the ordering matters.
//
// Per Robinhood's docs, these tokens implement ERC-8056 (uiMultiplier()) —
// one token equals one underlying share at launch, with the multiplier
// adjusting on corporate actions (splits, dividends). Unverified
// independently: the contracts page itself has no mention of ERC-8056 or
// uiMultiplier, and no linked page explains it either. Only the address is
// needed for a Flash quote, so no multiplier handling in this map yet either
// way — flagging so a future pass knows this claim came from outside these
// docs, not confirmed within them.
export const RH_STOCK_TOKENS: Record<string, string> = {
  // Stock tokens (20)
  AAPL: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
  AMD:  "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC",
  AMZN: "0x12f190a9F9d7D37a250758b26824B97CE941bF54",
  BABA: "0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4",
  BE:   "0x822CC93fFD030293E9842c30BBD678F530701867",
  COIN: "0x6330D8C3178a418788dF01a47479c0ce7CCF450b",
  CRCL: "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5",
  CRWV: "0x5f10A1C971B69e47e059e1dC91901B59b3fB49C3",
  GOOGL:"0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3",
  INTC: "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681",
  META: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35",
  MSFT: "0xe93237C50D904957Cf27E7B1133b510C669c2e74",
  MU:   "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD",
  NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  ORCL: "0xb0992820E760d836549ba69BC7598b4af75dEE03",
  PLTR: "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A",
  SNDK: "0xB90A19fF0Af67f7779afF50A882A9CfF42446400",
  SPCX: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa",
  TSLA: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
  USAR: "0xd917B029C761D264c6A312BBbcDA868658eF86a6",
  // Tokenized ETFs (5)
  QQQ:  "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68",
  SGOV: "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5",
  SLV:  "0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f",
  SPY:  "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
  CUSO: "0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344",
};

function cacheKey(symbol: string): string {
  return `rh:token:${symbol.toLowerCase()}`;
}

// Resolves a Robinhood Chain (chainId 4663) token symbol to its contract
// address. Stock/ETF tickers hit RH_STOCK_TOKENS first — the verified map
// sourced from Robinhood's own registry
// (https://docs.robinhood.com/chain/contracts) — and return immediately,
// never touching DexScreener. Everything else (memecoins, anything not in
// that map) falls through to DexScreener's search endpoint, same
// fetchWithTimeout + /latest/dex/search call lib/dexscreener.ts's
// resolveTokenTarget()/scanToken() use, filtered to chainId "robinhood"
// instead of ranked across all chains. There is no other symbol->address
// resolver for this chain anywhere in the codebase (lib/robinhoodLaunches.ts
// only ever sees addresses the upstream launch feed happens to hand it).
//
// The DexScreener path is deliberately the fallback, not the primary lookup,
// for anything RH_STOCK_TOKENS already covers: live-confirmed (2026-07-17)
// there is heavy ticker-impersonation activity on this chain (copycat
// "AAPL"/"TSLA"/etc. tokens, some with real liquidity of their own), and
// DexScreener's search has no way to distinguish the real Robinhood-issued
// token from a same-symbol impersonator — it just returns the first result
// above the liquidity floor. RH_STOCK_TOKENS sidesteps that entirely for the
// 25 symbols it covers.
//
// DexScreener path cached in Upstash (rh:token:{symbol}, 24h TTL) — popular
// symbols get re-queried on every swap attempt and DexScreener's search
// doesn't need hitting more than once a day per symbol. Fails open on cache
// errors (falls through to a live lookup): this is a rate-limiting cache,
// not a spend guard, unlike lib/usage.ts's fail-closed intel budgets —
// DexScreener's search endpoint is free. Only successful resolutions are
// cached; a miss is never cached, since a very-fresh launch can come back
// unindexed for a few minutes and shouldn't be locked out of resolution for
// a day once indexed (same reasoning as lib/robinhoodLaunches.ts's header
// comment). RH_STOCK_TOKENS hits skip the cache entirely — it's already an
// in-memory map, a Redis round-trip would only add latency.
export async function resolveRobinhoodToken(symbolOrAddress: string): Promise<string | null> {
  const q = symbolOrAddress.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) return q;
  if (!q) return null;

  const upper = q.toUpperCase();
  // Resolve the symbol alias (e.g. USDC -> USDG) BEFORE checking the pinned
  // address/stock maps — otherwise "USDC" would alias to "USDG" as a plain
  // string and fall through to the vulnerable DexScreener search below
  // instead of hitting RH_ADDRESS_ALIASES.USDG.
  const aliasedSymbol = RH_SYMBOL_ALIASES[upper] ?? upper;
  if (RH_ADDRESS_ALIASES[aliasedSymbol]) return RH_ADDRESS_ALIASES[aliasedSymbol];
  if (RH_STOCK_TOKENS[aliasedSymbol]) return RH_STOCK_TOKENS[aliasedSymbol];

  const symbol = RH_SYMBOL_ALIASES[upper] ?? q;
  const key = cacheKey(symbol);
  const redis = getRedis();
  if (redis) {
    try {
      const cached = await redis.get<string>(key);
      if (cached) return cached;
    } catch { /* cache miss path — fall through to live lookup */ }
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(`${BASE}/latest/dex/search?q=${encodeURIComponent(symbol)}`);
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const data = await res.json();
  const pairs: DexPair[] = data.pairs ?? [];
  const match = pairs.find(
    (p) => p.chainId === ROBINHOOD_CHAIN_ID && (p.liquidity?.usd ?? 0) > MIN_LIQUIDITY_USD,
  );
  const address = match?.baseToken?.address;
  if (!address) return null;

  if (redis) {
    try { await redis.set(key, address, { ex: CACHE_TTL_SECONDS }); } catch { /* non-fatal */ }
  }
  return address;
}

// ---------------------------------------------------------------------------
// Flash (Definitive) trading API — https://flash.definitive.fi
//
// Real schema confirmed two ways: Flash's own OpenAPI spec
// (https://flash.definitive.fi/v1/openapi.json) and a live quote call against
// Robinhood Chain (CASHCAT/USDG, 2026-07-15) — see CLAUDE.md's External
// Services table. Not an x402 source (regular API-key auth, like Delora), so
// it doesn't belong in docs/paid-data-sources.md, which is x402-only. Two
// corrections vs. what marketing copy/docs prose implied: the auth header is
// `x-definitive-api-key`, not `x-api-key`
// (requests fail silently without this — no 401 body hint, just an
// unauthenticated-shaped rejection), and Robinhood Chain's real stablecoin is
// USDG, not USDC (handled above in resolveRobinhoodToken/RH_CHAIN_STABLECOIN).
//
// FLASH_DEV_API_KEY is Definitive's own published shared dev key (their
// OpenAPI spec's `x-default` on the ApiKeyAuth scheme) — real and
// vendor-sanctioned, but shared/public. Set FLASH_API_KEY in the environment
// before any production traffic; the dev key is a fallback for local/dev use
// only.

const FLASH_BASE_URL = "https://flash.definitive.fi/v1";
const FLASH_API_KEY_HEADER = "x-definitive-api-key";
const FLASH_DEV_API_KEY = "dpka_513a2bd7_57a2_46d2_927b_2a3857fe271b";
const FLASH_QUOTE_TIMEOUT_MS = 12_000;
const FLASH_SUBMIT_TIMEOUT_MS = 15_000;

function flashApiKey(): string {
  return process.env.FLASH_API_KEY?.trim() || FLASH_DEV_API_KEY;
}

export type FlashChain =
  | "arbitrum" | "avalanche" | "base" | "bsc" | "ethereum" | "optimism"
  | "polygon" | "solana" | "hyperevm" | "plasma" | "monad" | "robinhood";

export type FlashOrderSide = "buy" | "sell";

export interface FlashQuoteRequest {
  targetChain: FlashChain;
  contraChain: FlashChain;
  targetAsset: string;
  contraAsset: string;
  side: FlashOrderSide;
  qty: string;
  orderType: FlashOrderType;
  quickTrade?: boolean;
  maxSlippage?: string;
  maxPriceImpact?: string;
  limitNotionalPrice?: string;
  funderAddress?: string;
  svmUseNativeSOL?: boolean;
  flashIntegratorFeeBps?: string;
  expireTime?: string;
  durationSeconds?: number;
  twapBucketCount?: number;
  triggers?: FlashPriceTrigger[];
  // Attach a take-profit / stop-loss pair to this entry. Same-chain only, and
  // requires funderAddress — the pair's signing payload is derived for that
  // wallet. The response then carries a SECOND signing payload under
  // attachedBracket.
  attachedBracket?: FlashBracketWire;
}

export interface FlashQuoteLeg {
  asset: "target" | "contra";
  amount: string;
  notional: string;
}

export interface FlashQuoteFees {
  estimatedFeeNotional: string;
}

export interface FlashSvmAccountMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface FlashSvmInstruction {
  programId: string;
  accounts: FlashSvmAccountMeta[];
  data: string;
}

export interface FlashWrapAction {
  nativeAsset: string;
  wrappedAsset: string;
  evmTx: { to: string; data: string; value: string } | null;
  svmInstructions: FlashSvmInstruction[] | null;
}

// SVM signing payloads — typed from the real spec for completeness, but
// Skopos has no Solana signer anywhere (lib/x402Agent.ts is EVM-only), so
// this branch is never exercised by anything in this codebase yet.
export interface FlashSvmActions {
  ataSetupIxs: FlashSvmInstruction[] | null;
  delegateIx: FlashSvmInstruction | null;
  sponsoredDelegateTx: string | null;
  orderMessage: string | null;
  nonce: string | null;
  deadline: string | null;
}

export interface FlashQuoteResponse {
  quoteId: string;
  orderType: FlashOrderType;
  side: FlashOrderSide;
  targetAsset: string;
  contraAsset: string;
  from: FlashQuoteLeg;
  to: FlashQuoteLeg;
  fees: FlashQuoteFees;
  wrap: FlashWrapAction | null;
  evm: {
    approveTx: { to: string; data: string } | null;
    permitTypedData: string; // empty string "" when not needed (NOT null)
    orderTypedData: string; // EIP-712 JSON string
  } | null;
  svm: FlashSvmActions | null;
  // Present only when the quote request carried an attachedBracket. The pair
  // signs SEPARATELY from the entry, over its own typed data, and sells the
  // asset the entry receives — so it can need its own approval on that asset
  // before submit, exactly as the entry does on the asset it spends.
  attachedBracket?: {
    evm: {
      approveTx: { to: string; data: string } | null;
      permitTypedData: string | null;
      orderTypedData: string;
    } | null;
    svm: unknown | null;
    salt: string | null;
    deadline: string;
    // The MOST of the received asset the pair's signature authorizes selling.
    // Protection is capped here: if the entry receives more than this, the
    // excess is unprotected. Surfaced to the user, not just carried.
    signedMaxFromAmount: string;
  } | null;
}

// Definitive's spec marks evm.permitTypedData/orderTypedData nullable, but
// the one live quote observed so far returned "" (not null) for the unused
// field — normalize defensively so the promised non-nullable string type
// actually holds even if a different pair/flow sends null.
function normalizeFlashQuoteResponse(data: FlashQuoteResponse): FlashQuoteResponse {
  if (!data.evm) return data;
  return {
    ...data,
    evm: {
      approveTx: data.evm.approveTx ?? null,
      permitTypedData: data.evm.permitTypedData ?? "",
      orderTypedData: data.evm.orderTypedData ?? "",
    },
  };
}

export async function getFlashQuote(req: FlashQuoteRequest): Promise<FlashQuoteResponse> {
  // Fee% re-verified at $50 notional (WETH/USDC, base, 2026-07-20) with the
  // real integrator key: estimatedFeeNotional ~0.22%, matching Definitive's
  // 10bps + our FLASH_INTEGRATOR_FEE_BPS 10bps stacked. The old ~14.8%
  // reading (CASHCAT/USDG, $1 notional, 2026-07-15) was confirmed a
  // thin-liquidity artifact of that tiny test trade, not a real cost.
  const res = await fetchWithTimeout(
    `${FLASH_BASE_URL}/quote`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", [FLASH_API_KEY_HEADER]: flashApiKey() },
      body: JSON.stringify(req),
    },
    FLASH_QUOTE_TIMEOUT_MS,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[flash] quote ${res.status}: ${body}`);
  }
  const data = (await res.json()) as FlashQuoteResponse;
  return normalizeFlashQuoteResponse(data);
}

export interface FlashSubmitRequest {
  targetChain: FlashChain;
  contraChain: FlashChain;
  targetAsset: string;
  contraAsset: string;
  side: FlashOrderSide;
  qty: string;
  orderType: FlashOrderType;
  funderAddress: string;
  userSignature: string;
  quickTrade?: boolean;
  maxSlippage?: string;
  maxPriceImpact?: string;
  limitNotionalPrice?: string;
  quoteId?: string;
  flashIntegratorFeeBps?: string;
  erc8021AttributionCode?: string;
  evmOrderTypedData?: string;
  evmPermitTypedData?: string;
  evmPermitSignature?: string;
  svmNonce?: string;
  svmDeadline?: string;
  svmSponsoredDelegateTx?: string;
  twapBucketCount?: number;
  triggers?: FlashPriceTrigger[];
  // Echo of the quote's pair, plus its own signature and the three values
  // baked into the signed typed data. salt is EVM-only.
  attachedBracket?: FlashBracketWire & {
    userSignature: string;
    salt?: string;
    svmNonce?: string;
    deadline: string;
    signedMaxFromAmount: string;
    evmPermitTypedData?: string;
    evmPermitSignature?: string;
  };
}

export interface FlashSubmitResponse {
  orderId: string;
}

export async function submitFlashOrder(req: FlashSubmitRequest): Promise<FlashSubmitResponse> {
  const res = await fetchWithTimeout(
    `${FLASH_BASE_URL}/order`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", [FLASH_API_KEY_HEADER]: flashApiKey() },
      body: JSON.stringify(req),
    },
    FLASH_SUBMIT_TIMEOUT_MS,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[flash] order ${res.status}: ${body}`);
  }
  return res.json();
}

// ── Order status + cancel — GET /orders, GET /orders/{orderId}, POST
// /orders/{orderId}/cancel. Previously unused (GitHub issue #74): a submitted
// order returned an ID and nothing else was ever done with it. Confirmed
// against Flash's real OpenAPI spec, same discipline as the quote/submit
// functions above.

export interface FlashAssetRef {
  id: string;
  name: string;
  address: string;
  ticker: string;
  chain: { id: string; name: string; namespace: string };
}

export interface FlashOrderFilled {
  targetAmount: string | null;
  contraAmount: string | null;
  averagePrice: string | null;
  averageNotionalPrice: string | null;
}

export interface FlashOrder {
  orderId: string;
  orderType: FlashOrderType;
  side: FlashOrderSide;
  status: FlashOrderStatus;
  closeReason: string | null;
  funderAddress: string;
  targetAsset: FlashAssetRef;
  contraAsset: FlashAssetRef;
  qty: string;
  filled: FlashOrderFilled | null;
  limitNotionalPrice: string | null;
  // Present when the order was priced in pair-rate rather than USD basis.
  // Skopos never sends it, but the funder's orders from other Flash clients
  // can carry it — see the note on FlashPriceTrigger.
  limitCrossPrice: string | null;
  trigger: FlashPriceTrigger | null;
  brackets: FlashPriceTrigger[] | null;
  // The attached pair's state, reported on the ENTRY order. A GET for the
  // pair itself 404s until it activates on the entry's first fill, so this
  // is the only way to observe it in that window.
  attachedBracket: AttachedBracketRead | null;
  // Set on the PAIR once it activates, pointing back at the entry it
  // protects. Its own row reads orderType "bracket", side "sell" — without
  // this the user sees an unexplained sell order sitting in their list and
  // may cancel their own protection.
  sourceEntryOrderId: string | null;
  maxPriceImpact: string | null;
  twapBucketCount: number | null;
  placedAt: string;
  acceptedAt: string | null;
  closedAt: string | null;
}

export interface FlashFill {
  status: "CHAIN_STATUS_UNSPECIFIED" | "CHAIN_STATUS_PROCESSED" | "CHAIN_STATUS_REORGED" | "CHAIN_STATUS_FINALIZED";
  notional: string;
  venues: string[];
  filledAt: string;
  rootOrderId: string;
  orderId: string;
  parentOrderId: string;
  transactionId: string;
  fillPrice: string;
  feeAmount: string;
  feeTicker: string;
  feeNotional: string;
  contraAmount: string;
  targetAmount: string;
}

// Lists orders for a funder wallet, most recent first. No pagination cursor
// needed yet — pageSize caps at Flash's own max (200), plenty for a chat
// card; add cursor-based paging if a wallet's order history ever exceeds it.
export async function listFlashOrders(
  funderAddress: string,
  opts?: { statuses?: FlashOrderStatus[]; pageSize?: number },
): Promise<FlashOrder[]> {
  const params = new URLSearchParams({ funderAddress });
  if (opts?.statuses?.length) params.set("statuses", opts.statuses.join(","));
  if (opts?.pageSize) params.set("pageSize", String(opts.pageSize));
  const res = await fetchWithTimeout(
    `${FLASH_BASE_URL}/orders?${params}`,
    { headers: { [FLASH_API_KEY_HEADER]: flashApiKey() } },
    FLASH_QUOTE_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`[flash] list orders ${res.status}`);
  const data = (await res.json()) as { orders: FlashOrder[] };
  return data.orders;
}

// funderAddress is required for ownership verification, same as the list
// endpoint — Flash won't return another wallet's order detail even with a
// valid order ID.
export async function getFlashOrder(orderId: string, funderAddress: string): Promise<{ order: FlashOrder; fills: FlashFill[] } | null> {
  const params = new URLSearchParams({ funderAddress });
  const res = await fetchWithTimeout(
    `${FLASH_BASE_URL}/orders/${orderId}?${params}`,
    { headers: { [FLASH_API_KEY_HEADER]: flashApiKey() } },
    FLASH_QUOTE_TIMEOUT_MS,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`[flash] get order ${res.status}`);
  return res.json();
}

// Exact bytes the funder wallet must sign (EIP-191 personal_sign on EVM) to
// authorize a cancel — identical across EVM/SVM per Flash's spec. Exported so
// the client signs precisely this string, never a reconstruction of it.
// Idempotent server-side: cancelling an already-cancelled order returns 200,
// not 422, per Flash's own spec — no need to check status before calling.
export async function cancelFlashOrder(orderId: string, cancelMessage: string, userSignature: string): Promise<{ ok: true }> {
  const res = await fetchWithTimeout(
    `${FLASH_BASE_URL}/orders/${orderId}/cancel`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", [FLASH_API_KEY_HEADER]: flashApiKey() },
      body: JSON.stringify({ cancelMessage, userSignature }),
    },
    FLASH_SUBMIT_TIMEOUT_MS,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[flash] cancel ${res.status}: ${body}`);
  }
  return res.json();
}

export class FlashUpdateError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`[flash] update ${status}: ${detail}`);
    this.name = "FlashUpdateError";
  }
}

// A 200 means the update was ACCEPTED, not applied — Flash executes it as an
// async cancel-and-replace, and order frames carry pendingUpdate:true until it
// lands. Callers must not tell the user the price has changed on the strength
// of this resolving.
export async function updateFlashOrder(orderId: string, body: FlashUpdateRequest): Promise<{ ok: true }> {
  const res = await fetchWithTimeout(
    `${FLASH_BASE_URL}/orders/${orderId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", [FLASH_API_KEY_HEADER]: flashApiKey() },
      body: JSON.stringify(body),
    },
    FLASH_SUBMIT_TIMEOUT_MS,
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new FlashUpdateError(res.status, detail);
  }
  return res.json();
}
