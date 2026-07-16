import { fetchWithTimeout } from "./http";

// Relay (relay.link) — bridging funds ONTO Robinhood Chain (4663) specifically.
// Delora doesn't support this chain at all; Flash (lib/flash.ts) only handles
// same-chain swaps once funds are already there (its own API rejects
// targetChain !== contraChain — confirmed live, 2026-07-16). Relay fills the
// one gap neither covers: getting funds from another chain (Base, Ethereum,
// etc.) onto Robinhood Chain in the first place. Additive only — does not
// touch lib/delora.ts, lib/flash.ts, or resolveLeg()/resolveFlashLeg().
//
// Confirmed live: GET https://api.relay.link/chains lists chain 4663 as
// "robinhood" / "Robinhood Chain" with depositEnabled:true, native ETH at
// the zero address (0x000...000 — NOT Flash's 0xEeee...EEeE sentinel, a
// different convention, don't conflate the two), and USDG
// (0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168) listed as a bridgeable
// featured/erc20 token.
//
// Quote shape is simpler than Flash's: every step observed so far (native
// ETH source, and ERC-20 USDC source — both live-tested, 2026-07-16) is
// kind:"transaction" — a raw {to,data,value,chainId} tx to send directly,
// the same shape Delora's `calldata` already is. No EIP-712 signing needed
// for either case tested. Relay's own OpenAPI spec (api.relay.link/documentation/json)
// documents a kind:"signature" step as also possible but leaves its `data`
// shape completely untyped (`{}` in the spec) — never observed in practice
// here, so RelayStepItem.data is typed for the confirmed transaction case
// and left loose otherwise rather than guessing a signature schema no one
// has verified.

const RELAY_BASE_URL = "https://api.relay.link";
const RELAY_QUOTE_TIMEOUT_MS = 15_000;

// Relay's native-currency convention — the zero address. Exported (rather
// than left as an inline literal at call sites) specifically so callers
// resolving a Robinhood Chain native-ETH address for a Relay request reach
// for THIS, not lib/flash.ts's resolveRobinhoodToken("ETH") — that returns
// Flash's 0xEeee...EEeE sentinel, a different convention for the same
// concept. Mixing the two silently produces a wrong quote, not an error.
export const RELAY_NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";

function relayHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // Optional — Relay works keyless, a key just raises rate limits. Unlike
  // Flash there's no shared dev key to fall back to; omitting the header
  // entirely (rather than sending an empty one) is the correct "unset" state.
  const key = process.env.RELAY_API_KEY?.trim();
  if (key) headers["x-api-key"] = key;
  return headers;
}

export type RelayTradeType = "EXACT_INPUT" | "EXACT_OUTPUT" | "EXPECTED_OUTPUT";

export interface RelayQuoteRequest {
  user: string;
  originChainId: number;
  destinationChainId: number;
  originCurrency: string;
  destinationCurrency: string;
  amount: string;
  tradeType: RelayTradeType;
  recipient?: string;
  slippageTolerance?: string;
}

export interface RelayTransactionData {
  from: string;
  to: string;
  data: string;
  value: string;
  chainId: number;
  gas?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

export interface RelayStepItem {
  status: "complete" | "incomplete";
  // Confirmed for kind:"transaction" (both live tests). kind:"signature"
  // items are a real possibility per Relay's spec but have an unverified
  // shape — don't assume RelayTransactionData for those without checking.
  data: RelayTransactionData | Record<string, unknown>;
  check?: { endpoint: string; method: string };
}

export interface RelayStep {
  id: "deposit" | "approve" | "authorize" | "authorize1" | "authorize2" | "swap" | "send";
  action: string;
  description: string;
  kind: "transaction" | "signature";
  requestId: string;
  depositAddress?: string;
  items: RelayStepItem[];
}

export interface RelayCurrencyAmount {
  currency: { chainId: number; address: string; symbol: string; name: string; decimals: number };
  amount: string;
  amountFormatted: string;
  amountUsd: string;
  minimumAmount: string;
}

export interface RelayFees {
  gas: RelayCurrencyAmount;
  relayer: RelayCurrencyAmount;
  relayerGas: RelayCurrencyAmount;
  relayerService: RelayCurrencyAmount;
  app: RelayCurrencyAmount;
  subsidized: RelayCurrencyAmount;
}

// Real response has more fields (refundCurrency, totalImpact, route, etc.) —
// only the ones a caller actually needs are typed here.
export interface RelayQuoteDetails {
  operation: string;
  sender: string;
  recipient: string;
  currencyIn: RelayCurrencyAmount;
  currencyOut: RelayCurrencyAmount;
  timeEstimate: number;
  rate: string;
}

export interface RelayQuoteResponse {
  steps: RelayStep[];
  fees: RelayFees;
  details: RelayQuoteDetails;
}

export async function getRelayQuote(req: RelayQuoteRequest): Promise<RelayQuoteResponse> {
  const res = await fetchWithTimeout(
    `${RELAY_BASE_URL}/quote/v2`,
    { method: "POST", headers: relayHeaders(), body: JSON.stringify(req) },
    RELAY_QUOTE_TIMEOUT_MS,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[relay] quote ${res.status}: ${body}`);
  }
  return res.json();
}
