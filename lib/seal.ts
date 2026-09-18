import { resolveChainId } from "./chains";
import { validateBracket, type AttachedBracket } from "./flashBracket";
import type { FlashOrderIntent } from "@/app/api/chat/route";

// A Seal is a reusable trading policy: everything needed to build a Flash order
// EXCEPT the size and the person. One Seal, many wallets — each instantiation
// produces a fresh quote and a separate order owned entirely by the wallet that
// signed it. The Seal itself is unchanged by being used.
//
// The policy is deliberately FlashOrderIntent (app/api/chat/route.ts) minus
// `qty`, so compiling one is a field copy rather than a translation. Nothing
// here knows about Flash's wire format, HTTP, or Redis — this half is pure so
// it can be tested without a funded wallet, which is the only kind of test this
// repo has for the order path.
//
// Two things a Seal must never carry, enforced by the type and by the route's
// allowlist: anything a QUOTE produced (prices, quoteId, calldata, typed data,
// signatures) and anything a CONSUMER owns (addresses, balances, order ids). A
// Seal holding a quote would be a stale order pretending to be a policy, and
// that distinction is the whole product.

export const SEAL_VERSION = 1;

export const SEAL_TITLE_MAX = 60;

// Trigger orders are always sells — the same rule app/api/flash-order/route.ts
// applies, kept here so a Seal cannot encode a combination the resolver would
// later refuse with a wallet already connected.
export type SealOrderType = "limit" | "stop-loss" | "take-profit" | "twap";

/**
 * Bounds the creator puts on the one number the consumer supplies.
 *
 * Units follow Flash's own `qty`: the asset being SPENT. A buy is bounded in
 * contra units (dollars of USDC, or USDG on Robinhood Chain), a sell in target
 * units (tokens). Stating that in the UI is not decoration — it is the single
 * most misreadable field in the product, and it already shipped wrong once on
 * the headless surface.
 */
export interface SealSizing {
  min:       string;
  max:       string;
  suggested: string;
}

export interface SealPolicy {
  id:        string;
  version:   number;
  title:     string;
  creator:   string;  // lowercase EVM address of the publishing wallet
  createdAt: number;
  retired?:  boolean;

  side:             "buy" | "sell";
  orderType:        SealOrderType;
  token:            string;
  // PINNED, never inferred per consumer. findFundingChains() picks a chain from
  // a wallet's own balances, so an unpinned policy would let two wallets land
  // on different chains with different liquidity and a different contra asset —
  // that is two policies, not one executed twice. The chain is part of the
  // policy.
  chain:            string;
  priceLevel?:      string;
  triggerType?:     "upper" | "lower";
  durationSeconds?: number;
  twapBucketCount?: number;
  bracket?:         AttachedBracket;
  /**
   * Largest price impact the creator will let a take accept, as a decimal
   * ("0.05" = 5%).
   *
   * A Seal is sized by the consumer, so the creator cannot know how thin the
   * book will be when someone takes it. Without a cap, a policy written against
   * a liquid pair can be executed into a bad one by a size its author never
   * imagined — and the consumer, who did not write the policy, is the one who
   * eats it.
   */
  maxImpact?:       string;
  sizing:           SealSizing;
}

/** Everything a creator supplies. The server owns id, version, createdAt. */
export type SealDraft = Omit<SealPolicy, "id" | "version" | "createdAt" | "retired">;

export type SealIssueCode =
  | "title_missing" | "title_too_long"
  | "token_invalid" | "chain_unknown" | "chain_unsupported"
  | "price_required" | "price_invalid"
  | "trigger_side" | "trigger_type_mismatch"
  | "duration_required" | "duration_too_short"
  | "bucket_count_invalid"
  | "bracket_not_allowed" | "bracket_invalid"
  | "sizing_invalid" | "sizing_unordered"
  | "creator_invalid" | "impact_invalid";

export interface SealIssue {
  code:    SealIssueCode;
  message: string;
}

const TOKEN_RE   = /^[A-Za-z][A-Za-z0-9._-]{0,14}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
// Flash's own floor for a TWAP schedule, mirrored from the paid order route.
const TWAP_MIN_SECONDS = 300;

function positive(raw: string | undefined): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Trims, collapses whitespace and strips control characters from creator text. */
export function sanitizeTitle(raw: string): string {
  // Walked by code point rather than matched with a control-character class:
  // the class only ever existed as invisible bytes in the source, which is a
  // poor thing to rest a sanitizer on. This renders to strangers.
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Every reason a policy must not be publishable.
 *
 * All of these are caught HERE, at publish, rather than at instantiate. A Seal
 * that cannot be compiled is worse than an error: it is a link the creator has
 * already shared, which fails for every stranger who opens it.
 */
export function validateSealPolicy(
  draft: SealDraft,
  supportedChainIds: ReadonlySet<number>,
): SealIssue | null {
  const title = sanitizeTitle(draft.title ?? "");
  if (!title) return { code: "title_missing", message: "Give the Seal a title." };
  if (title.length > SEAL_TITLE_MAX) {
    return { code: "title_too_long", message: `Title must be ${SEAL_TITLE_MAX} characters or fewer.` };
  }

  if (!ADDRESS_RE.test(draft.creator ?? "")) {
    return { code: "creator_invalid", message: "A Seal must be published by a connected EVM wallet." };
  }

  if (!TOKEN_RE.test(draft.token ?? "")) {
    return { code: "token_invalid", message: `"${draft.token}" isn't a token symbol I can pin.` };
  }

  const chainId = resolveChainId(draft.chain ?? "");
  if (!chainId) return { code: "chain_unknown", message: `I don't recognize "${draft.chain}" as a chain.` };
  if (!supportedChainIds.has(chainId)) {
    return { code: "chain_unsupported", message: `Advanced orders aren't available on ${draft.chain} yet.` };
  }

  const isTrigger = draft.orderType === "stop-loss" || draft.orderType === "take-profit";
  if (isTrigger && draft.side !== "sell") {
    return { code: "trigger_side", message: `A ${draft.orderType} order sells — it can't be a buy.` };
  }
  if (isTrigger) {
    const expected = draft.orderType === "stop-loss" ? "lower" : "upper";
    if (draft.triggerType !== expected) {
      return { code: "trigger_type_mismatch", message: `A ${draft.orderType} triggers on the ${expected} side.` };
    }
  }

  if (draft.orderType === "twap") {
    if (draft.durationSeconds === undefined) {
      return { code: "duration_required", message: "A TWAP needs a duration." };
    }
    if (!Number.isInteger(draft.durationSeconds) || draft.durationSeconds < TWAP_MIN_SECONDS) {
      return { code: "duration_too_short", message: `A TWAP must run for at least ${TWAP_MIN_SECONDS} seconds.` };
    }
    if (draft.twapBucketCount !== undefined
        && (!Number.isInteger(draft.twapBucketCount) || draft.twapBucketCount <= 0)) {
      return { code: "bucket_count_invalid", message: "Bucket count must be a positive whole number." };
    }
  } else {
    if (draft.priceLevel === undefined) {
      return { code: "price_required", message: `A ${draft.orderType} order needs a price.` };
    }
    if (positive(draft.priceLevel) === null) {
      return { code: "price_invalid", message: `"${draft.priceLevel}" isn't a usable price.` };
    }
  }

  if (draft.bracket) {
    // Flash brackets market, limit and twap entries. A trigger order already IS
    // a trigger and cannot carry one — refusing here costs nothing, where
    // letting it through costs a shared link that fails on first use.
    if (isTrigger) {
      return { code: "bracket_not_allowed", message: "A stop-loss or take-profit is already a trigger — it can't carry a bracket." };
    }
    const issue = validateBracket(draft.bracket);
    if (issue) {
      const message = issue.code === "tp_not_above_sl"
        ? "The take-profit must sit above the stop-loss."
        : issue.code === "mixed_basis"
          ? "Both bracket legs must be priced the same way."
          : "Bracket prices must be greater than zero.";
      return { code: "bracket_invalid", message };
    }
  }

  if (draft.maxImpact !== undefined) {
    const cap = Number(draft.maxImpact);
    // A decimal, not a percent. "5" would read as 500% and cap nothing, which
    // is worse than having no cap because the page would claim one.
    if (!Number.isFinite(cap) || cap <= 0 || cap > 1) {
      return { code: "impact_invalid", message: "Max price impact is a decimal between 0 and 1 — 0.05 is 5%." };
    }
  }

  const min = positive(draft.sizing?.min);
  const max = positive(draft.sizing?.max);
  const suggested = positive(draft.sizing?.suggested);
  if (min === null || max === null || suggested === null) {
    return { code: "sizing_invalid", message: "Minimum, maximum and suggested size must all be greater than zero." };
  }
  if (!(min <= suggested && suggested <= max)) {
    return { code: "sizing_unordered", message: "Sizes must read minimum ≤ suggested ≤ maximum." };
  }

  return null;
}

export type SizeIssueCode = "size_invalid" | "size_below_min" | "size_above_max";

export interface SizeIssue {
  code:    SizeIssueCode;
  message: string;
}

/**
 * The consumer's only input, checked against the creator's bounds.
 *
 * Server-side and authoritative. The input on the page is a convenience; this
 * runs again at submit, because by then the number has made a round trip
 * through a browser we do not control.
 */
export function validateSize(policy: SealPolicy, size: string): SizeIssue | null {
  const n = positive(size);
  if (n === null) return { code: "size_invalid", message: `"${size}" isn't a usable amount.` };
  if (n < Number(policy.sizing.min)) {
    return { code: "size_below_min", message: `This Seal starts at ${policy.sizing.min}.` };
  }
  if (n > Number(policy.sizing.max)) {
    return { code: "size_above_max", message: `This Seal caps at ${policy.sizing.max}.` };
  }
  return null;
}

/**
 * policy + size → the exact intent the existing resolver already knows.
 *
 * Pure and total: given a validated policy and a validated size there is one
 * intent and no I/O. Both the quote step and the submit step call this, so the
 * order that gets signed and the order that gets sent are derived from the same
 * function applied to the same stored record — which is what stops a browser
 * from submitting something other than what the page displayed.
 */
export function compileSeal(policy: SealPolicy, size: string): FlashOrderIntent {
  return {
    side:      policy.side,
    orderType: policy.orderType,
    token:     policy.token,
    qty:       size,
    chain:     policy.chain,
    ...(policy.priceLevel      !== undefined ? { priceLevel:      policy.priceLevel } : {}),
    ...(policy.triggerType     !== undefined ? { triggerType:     policy.triggerType } : {}),
    ...(policy.durationSeconds !== undefined ? { durationSeconds: policy.durationSeconds } : {}),
    ...(policy.twapBucketCount !== undefined ? { twapBucketCount: policy.twapBucketCount } : {}),
    ...(policy.bracket         !== undefined ? { bracket:         policy.bracket } : {}),
    ...(policy.maxImpact       !== undefined ? { maxImpact:       policy.maxImpact } : {}),
  };
}

export type ImpactIssue = { code: "impact_too_high"; message: string };

/**
 * Checks Flash's own impact estimate against the creator's cap.
 *
 * Flash's spec is explicit that the returned estimate can exceed the
 * maxPriceImpact the request asked for, so sending the cap is necessary and not
 * sufficient — the answer has to be read back and refused here.
 */
export function impactRejection(estimated: string | null | undefined, maxImpact: string | undefined): ImpactIssue | null {
  if (!maxImpact) return null;
  const cap = Number(maxImpact);
  const got = Number(estimated);
  if (!Number.isFinite(cap) || !Number.isFinite(got)) return null;
  if (got <= cap) return null;
  return {
    code: "impact_too_high",
    message: `That size would move the price ${(got * 100).toFixed(2)}%, past this Seal's ${(cap * 100).toFixed(2)}% limit. Try a smaller amount.`,
  };
}

/**
 * What the consumer is actually spending, in words.
 *
 * `qty` flips unit between sides and that is the field a stranger is most
 * likely to misread, so no surface should ever render the number bare.
 */
export function sizeUnitLabel(policy: SealPolicy, contraSymbol: string): string {
  return policy.side === "buy" ? contraSymbol : policy.token.toUpperCase();
}

export function isSizeInContraUnits(policy: SealPolicy): boolean {
  return policy.side === "buy";
}

export interface TypedDataExpectation {
  /** Contract address of the asset the order spends, as the resolver reported it. */
  fromToken: string;
}

/**
 * Checks Flash's EIP-712 payload against the order we derived, before the user
 * is ever shown something to sign.
 *
 * Today `/api/flash/submit` forwards whatever the browser sends and nothing
 * compares the typed data to the quote (issue #83). That is survivable while
 * the person supplying the fields is the person who typed the order. A Seal
 * removes that assumption — the policy came from a stranger — so the payload
 * has to be checked against the compiled intent on the way out.
 *
 * Absent or unparseable fields do NOT fail. We can only assert what is present,
 * and refusing a quote because Flash changed a payload's shape would break
 * live orders to defend against nothing. A field that IS present and disagrees
 * is the actual attack shape, and that refuses.
 */
export function typedDataMismatch(
  orderTypedData: string,
  expected: TypedDataExpectation,
): string | null {
  let message: Record<string, unknown>;
  try {
    const parsed = JSON.parse(orderTypedData) as { message?: Record<string, unknown> };
    if (!parsed?.message || typeof parsed.message !== "object") return null;
    message = parsed.message;
  } catch {
    return null;
  }

  const fromToken = message.fromToken;
  if (typeof fromToken !== "string" || !fromToken.startsWith("0x")) return null;
  if (fromToken.toLowerCase() !== expected.fromToken.toLowerCase()) {
    return `The order to sign spends ${fromToken}, but this Seal spends ${expected.fromToken}.`;
  }
  return null;
}

// Arc and Robinhood Chain quote against their own stablecoins. Duplicated from
// RH_CHAIN_STABLECOIN rather than imported, because this module is imported by
// client components (the size panel) and lib/flash drags @upstash/redis into
// whatever imports it. A test asserts the two stay equal so the duplication
// cannot silently drift.
const ROBINHOOD_CHAIN_ID = 4663;
const ARC_CHAIN_ID = 5042;

export function contraSymbolForChain(chain: string): string {
  const id = resolveChainId(chain);
  if (id === ROBINHOOD_CHAIN_ID) return "USDG";
  if (id === ARC_CHAIN_ID) return "USDC";
  return "USDC";
}

/**
 * The policy as one sentence.
 *
 * Shared by the Seal page and its share card. Those are the two places a
 * stranger reads what they are about to sign, and a policy that says one thing
 * on the card and another on the page is worse than having no card.
 */
export function sealPolicyLine(policy: SealPolicy, contraSymbol: string): string {
  const sym = policy.token.toUpperCase();
  const money = policy.side === "buy" ? contraSymbol : sym;

  const head =
    policy.orderType === "limit"        ? `${policy.side} ${sym} at $${policy.priceLevel}`
    : policy.orderType === "stop-loss"  ? `sell ${sym} if it drops below $${policy.priceLevel}`
    : policy.orderType === "take-profit" ? `sell ${sym} when it hits $${policy.priceLevel}`
    : `${policy.side} ${sym} evenly over ${Math.round((policy.durationSeconds ?? 0) / 3600)}h`;

  const protection = policy.bracket
    ? `, protected by a stop at $${policy.bracket.stopLoss.price} and a target at $${policy.bracket.takeProfit.price}`
    : "";

  return `${head} on ${policy.chain}${protection} — sized by you, in ${money}.`;
}

/**
 * The exact bytes a creator signs to publish.
 *
 * Built the way lib/flashUpdate.ts builds Flash's update message and for the
 * same reason: one function produces both the string that gets signed and the
 * record that gets stored, so they cannot drift. **Anything absent from this
 * message is not attested** — a field the creator did not sign is a field
 * someone else could have set, so every material field appears here, including
 * the ones a careless reader would call cosmetic.
 *
 * No nonce, deliberately. The push-subscribe flow needs one because its
 * signature grants an ongoing capability; this one attests authorship of a
 * specific body, and replaying it can only republish the identical policy the
 * same author already wrote.
 */
export function sealPublishMessage(draft: SealDraft): string {
  const sym = draft.token.toUpperCase();
  const lines = [
    "Skopos — Publish Seal",
    `Title: ${sanitizeTitle(draft.title)}`,
    `Order: ${draft.side} ${draft.orderType} ${sym} on ${draft.chain.trim().toLowerCase()}`,
  ];
  if (draft.priceLevel !== undefined) lines.push(`Price: ${draft.priceLevel}`);
  if (draft.triggerType !== undefined) lines.push(`Trigger: ${draft.triggerType}`);
  if (draft.durationSeconds !== undefined) lines.push(`Duration: ${draft.durationSeconds}s`);
  if (draft.twapBucketCount !== undefined) lines.push(`Buckets: ${draft.twapBucketCount}`);
  if (draft.bracket) {
    const { takeProfit: tp, stopLoss: sl } = draft.bracket;
    lines.push(`Bracket: take-profit ${tp.price} (${tp.basis}) / stop-loss ${sl.price} (${sl.basis})`);
  }
  if (draft.maxImpact !== undefined) lines.push(`Max impact: ${draft.maxImpact}`);
  lines.push(`Size: ${draft.sizing.min}-${draft.sizing.max}, suggested ${draft.sizing.suggested}`);
  lines.push(`Creator: ${draft.creator.toLowerCase()}`);
  return lines.join("\n");
}
