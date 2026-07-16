import { fetchWithTimeout } from "./http";
import { getRedis } from "./redis";
import type { DexPair } from "./dexscreener";

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
const RH_ADDRESS_ALIASES: Record<string, string> = {
  ETH: NATIVE_ETH_SENTINEL,
  WETH: NATIVE_ETH_SENTINEL,
};

function cacheKey(symbol: string): string {
  return `rh:token:${symbol.toLowerCase()}`;
}

// Resolves a Robinhood Chain (chainId 4663) token symbol to its contract
// address via DexScreener's search endpoint — same fetchWithTimeout +
// /latest/dex/search call lib/dexscreener.ts's resolveTokenTarget()/
// scanToken() use, filtered to chainId "robinhood" instead of ranked across
// all chains. There is no other symbol->address resolver for this chain
// anywhere in the codebase (lib/robinhoodLaunches.ts only ever sees
// addresses the upstream launch feed happens to hand it).
//
// Cached in Upstash (rh:token:{symbol}, 24h TTL) — popular symbols get
// re-queried on every swap attempt and DexScreener's search doesn't need
// hitting more than once a day per symbol. Fails open on cache errors (falls
// through to a live lookup): this is a rate-limiting cache, not a spend
// guard, unlike lib/usage.ts's fail-closed intel budgets — DexScreener's
// search endpoint is free. Only successful resolutions are cached; a miss is
// never cached, since a very-fresh launch can come back unindexed for a few
// minutes and shouldn't be locked out of resolution for a day once indexed
// (same reasoning as lib/robinhoodLaunches.ts's header comment).
export async function resolveRobinhoodToken(symbolOrAddress: string): Promise<string | null> {
  const q = symbolOrAddress.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) return q;
  if (!q) return null;

  const upper = q.toUpperCase();
  if (RH_ADDRESS_ALIASES[upper]) return RH_ADDRESS_ALIASES[upper];

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

export type FlashOrderType =
  | "market" | "limit" | "twap" | "stop" | "stop-loss" | "take-profit" | "bracket";

export interface FlashPriceTrigger {
  notionalPrice: string;
  triggerType: "upper" | "lower";
}

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
  // TODO: re-verify fee% at $50+ trade size before launch. The one live
  // smoke test so far (CASHCAT/USDG, $1 notional, 2026-07-15) showed an
  // estimatedFeeNotional of ~14.8% — plausibly a thin-liquidity artifact of
  // an intentionally tiny test trade, not a real per-trade cost. Don't build
  // fee guards, minimums, or user-facing fee copy off that single data point.
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
