import type { FlashPriceBasis, FlashOrderType } from "./flashUpdate";

// Pure, dependency-free half of attached bracket orders — leg shapes, the
// three rules Flash enforces between them, and the eligibility predicates.
// Split from lib/flash.ts for the same reason lib/flashUpdate.ts is: the
// browser signs the bracket payload and must not pull @upstash/redis into
// the bundle. lib/flash.ts re-exports everything here.
//
// An attached bracket is a take-profit / stop-loss pair placed WITH an entry
// order in one quote → two signatures → one submit. It protects what the
// entry RECEIVES: when a leg's trigger is reached it sells the received
// asset and the entry stops filling. The pair is one-cancels-other, so only
// one exit ever executes.

// A leg carries exactly one trigger price, plus an optional limit price for
// the exit it places. Omitting limitPrice exits at market; setting it rests
// the exit at that price and it can go unfilled if the market keeps moving —
// the classic stop-limit vs stop-market tradeoff, chosen per leg.
export interface BracketLeg {
  price: string;
  basis: FlashPriceBasis;
  limitPrice?: string;
}

export interface AttachedBracket {
  takeProfit: BracketLeg;
  stopLoss: BracketLeg;
}

// Only these entry types can carry a bracket. Notably absent: the trigger
// types — a stop-loss cannot itself be bracketed — and Flash rejects the
// rest outright.
export const BRACKETABLE_ORDER_TYPES: ReadonlySet<FlashOrderType> =
  new Set<FlashOrderType>(["market", "limit", "twap"]);

export function isBracketableOrderType(orderType: FlashOrderType): boolean {
  return BRACKETABLE_ORDER_TYPES.has(orderType);
}

export type BracketIssue =
  | { code: "mixed_basis" }
  | { code: "tp_not_above_sl" }
  | { code: "non_positive" }
  | { code: "native_entry" };

// Flash's three between-leg rules, checked before a quote is requested so a
// bad pair costs nothing. Ordering matters to the user, not just the API: a
// take-profit at or below the stop-loss is almost always a transposition,
// and quoting it would return a confusing upstream error instead of saying
// so plainly.
export function validateBracket(bracket: AttachedBracket): BracketIssue | null {
  const { takeProfit, stopLoss } = bracket;
  if (takeProfit.basis !== stopLoss.basis) return { code: "mixed_basis" };

  const tp = parseFloat(takeProfit.price);
  const sl = parseFloat(stopLoss.price);
  if (!(tp > 0) || !(sl > 0)) return { code: "non_positive" };
  if (tp <= sl) return { code: "tp_not_above_sl" };
  return null;
}

// The entry must receive an ERC-20. Flash cannot bracket an entry that buys
// the chain's native gas asset, so the caller quotes to the wrapped token
// (WETH rather than ETH) instead — Skopos already does this coercion for
// TWAP via FLASH_NATIVE_WRAP_SYMBOL, and brackets reuse it.
export function bracketNeedsWrappedEntry(receivedSymbol: string, nativeSymbol: string | undefined): boolean {
  if (!nativeSymbol) return false;
  return receivedSymbol.toUpperCase() === nativeSymbol.toUpperCase();
}

// Pre-activation lifecycle of the pair, reported on the ENTRY order until it
// becomes an order of its own. A GET for the pair 404s before activation, so
// this is the only way to observe it in that window.
export type AttachedBracketStatus = "pending_activation" | "active" | "never_activated";

export interface AttachedBracketRead {
  status: AttachedBracketStatus;
  bracketOrderId: string | null;
  takeProfit: { notionalPrice?: string; crossPrice?: string; limitPrice?: string };
  stopLoss: { notionalPrice?: string; crossPrice?: string; limitPrice?: string };
  signedMaxFromAmount: string;
}
