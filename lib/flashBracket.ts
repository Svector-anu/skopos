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

// ── one-message parsing ──────────────────────────────────────────────────────
// "buy $500 of ETH at $2800, stop $2500, target $3500" arrives as ONE message.
// Rather than teach every entry regex about brackets, the pair is extracted as
// a suffix and stripped, and the remainder goes to the existing entry parser
// completely unchanged. Compositional: entry phrasings and bracket phrasings
// evolve independently, and a message with no pair takes the old path byte for
// byte.
//
// BOTH legs are required. One leg alone is an ordinary stop-loss or
// take-profit order and must keep falling through to the existing trigger
// regexes — "sell 2 ETH if it drops below $2000" is not half a bracket.

// Must not end on a separator. A greedy [\d,]* swallows the comma in
// "stop $2500, target $3500" and yields "2500,", which normalizeFlashPrice
// then correctly refuses — turning a list into a total parse failure rather
// than a partial one. Anchoring the last character as a digit keeps grouped
// numbers ("2,500") whole while leaving a trailing separator behind.
const BRACKET_NUM = String.raw`(\d(?:[\d,]*\d)?(?:\.\d+)?)`;
// "stop at 2500", "stop 2500", "stop: 2500", "sl @ 2500", "stop of 2500"
const BRACKET_JOIN = String.raw`(?:\s*(?:at|@|of|to|:|=)\s*|\s+)`;
// Longest alternative first so "stop loss 2500" doesn't match the bare "stop".
const STOP_LEG_RE = new RegExp(String.raw`\b(?:stop[\s-]?loss|stoploss|stop|sl)\b${BRACKET_JOIN}\$?${BRACKET_NUM}`, "i");
const TP_LEG_RE = new RegExp(String.raw`\b(?:take[\s-]?profit|takeprofit|target|tp)\b${BRACKET_JOIN}\$?${BRACKET_NUM}`, "i");

// Connectives left behind once the legs are cut out ("… ETH at $2800 , with a
// and ."). Cleaning these up matters: the remainder is fed to regexes that
// anchor on word boundaries, and a trailing "with a" changes what they match.
const BRACKET_LEFTOVERS_RE = /\s*(?:,|;|and|with(?:\s+an?)?|plus|\+)\s*$/i;

export interface BracketParse {
  bracket: AttachedBracket;
  /** The message with both legs removed, for the existing entry parser. */
  remainder: string;
}

// `normalize` is injected rather than imported so this module stays free of
// any dependency — it is the same normalizeFlashPrice the update path uses,
// which refuses ambiguous comma placement instead of guessing a decimal.
export function extractBracket(
  input: string,
  normalize: (raw: string) => string | null,
): BracketParse | null {
  const stop = STOP_LEG_RE.exec(input);
  const tp = TP_LEG_RE.exec(input);
  // One leg on its own is a plain trigger order, not a bracket.
  if (!stop || !tp) return null;

  const stopPrice = normalize(stop[1]);
  const tpPrice = normalize(tp[1]);
  if (!stopPrice || !tpPrice) return null;

  // Cut the later span first so the earlier one's indices stay valid.
  const spans = [stop, tp].sort((a, b) => b.index - a.index);
  let remainder = input;
  for (const m of spans) {
    remainder = remainder.slice(0, m.index) + " " + remainder.slice(m.index + m[0].length);
  }
  remainder = remainder.replace(/\s+/g, " ").trim();
  // Strip trailing connectives repeatedly — "…, with a" leaves two.
  let previous: string;
  do {
    previous = remainder;
    remainder = remainder.replace(BRACKET_LEFTOVERS_RE, "").trim();
  } while (remainder !== previous);

  return {
    bracket: {
      takeProfit: { price: tpPrice, basis: "notional" },
      stopLoss: { price: stopPrice, basis: "notional" },
    },
    remainder,
  };
}
