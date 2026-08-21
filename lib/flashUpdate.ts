// Pure, dependency-free half of the Flash integration: types, price parsing,
// and the byte-exact update-message construction. Split out of lib/flash.ts
// for the same reason lib/alchemy-types.ts was split out of lib/alchemy.ts
// (commit d5d05a4) — lib/flash.ts imports @upstash/redis and would drag the
// whole server module graph into the client bundle. app/app/page.tsx signs
// the update message in the browser, so it needs these and must NOT reach
// for lib/flash.ts to get them. lib/flash.ts re-exports everything here, so
// server-side callers are unaffected.

export type FlashOrderType =
  | "market" | "limit" | "twap" | "stop" | "stop-loss" | "take-profit" | "bracket";

// Serves both directions: the `triggers` we send on a quote/submit, and the
// `trigger` Flash reads back on an order. Exactly one price is ever set —
// Flash's own schema makes notionalPrice and crossPrice mutually exclusive.
// Skopos only ever SENDS notionalPrice today, but listFlashOrders returns
// every order for the funder wallet, including ones placed through another
// Flash client in cross basis — so the read side has to model both. Use
// triggerPriceOf() rather than reaching for a field directly.
export interface FlashPriceTrigger {
  notionalPrice?: string;
  crossPrice?: string;
  triggerType: "upper" | "lower";
}

export type FlashPriceBasis = "notional" | "cross";

export interface FlashTriggerPrice {
  price: string;
  basis: FlashPriceBasis;
  triggerType: "upper" | "lower";
}

// Reads a trigger's single set price along with which basis it is in. The
// basis matters beyond display: an update must restate the trigger in the
// basis it was PLACED with (Flash rejects a switch), so this is the one place
// that decides which of the two fields is authoritative.
export function triggerPriceOf(trigger: FlashPriceTrigger | null | undefined): FlashTriggerPrice | null {
  if (!trigger) return null;
  if (trigger.notionalPrice) return { price: trigger.notionalPrice, basis: "notional", triggerType: trigger.triggerType };
  if (trigger.crossPrice) return { price: trigger.crossPrice, basis: "cross", triggerType: trigger.triggerType };
  return null;
}

export type FlashOrderStatus =
  | "ORDER_STATUS_UNSPECIFIED" | "ORDER_STATUS_PENDING" | "ORDER_STATUS_ACCEPTED"
  | "ORDER_STATUS_PARTIALLY_FILLED" | "ORDER_STATUS_FILLED" | "ORDER_STATUS_CANCELLED"
  | "ORDER_STATUS_REJECTED" | "ORDER_STATUS_TERMINATED";

// Statuses where a cancel request is still meaningful — anything else has
// already reached a terminal state (filled, cancelled, rejected, terminated).
export const FLASH_CANCELLABLE_STATUSES: ReadonlySet<FlashOrderStatus> = new Set([
  "ORDER_STATUS_PENDING", "ORDER_STATUS_ACCEPTED", "ORDER_STATUS_PARTIALLY_FILLED",
]);

// Deliberately NOT the cancellable set. Flash documents an order as updatable
// only once it is live under its orderId — ACCEPTED or PARTIALLY_FILLED —
// whereas PENDING is still being processed and a PATCH against it 422s.
// Reusing FLASH_CANCELLABLE_STATUSES here would offer the user an edit
// control that always fails.
export const FLASH_UPDATABLE_STATUSES: ReadonlySet<FlashOrderStatus> = new Set([
  "ORDER_STATUS_ACCEPTED", "ORDER_STATUS_PARTIALLY_FILLED",
]);

// Only these four accept a PATCH; Flash rejects every other type with 422.
// Notably absent: twap (no repricing axis), market (already executing), and
// bracket (the activated pair — cancel it instead).
export const FLASH_UPDATABLE_ORDER_TYPES: ReadonlySet<FlashOrderType> = new Set<FlashOrderType>([
  "limit", "stop", "stop-loss", "take-profit",
]);

// Which price an update to this order would move. Flash keys this off the
// order type, not off which fields happen to be populated:
//   limit                          → the resting limit price
//   stop / stop-loss / take-profit → the trigger threshold
// The "-limit" variants (a trigger type carrying limitNotionalPrice) can move
// both in one PATCH. Skopos never places those — resolveFlashOrderLeg only
// sets limitNotionalPrice when orderType === "limit" — but another Flash
// client using the same funder wallet can, and those orders show up in
// listFlashOrders. Rather than half-support them, they are reported here as
// their trigger axis only, which is always a valid update for them.
export type FlashUpdateAxis = "limit" | "trigger";

export function flashUpdateAxis(order: { orderType: FlashOrderType }): FlashUpdateAxis | null {
  if (!FLASH_UPDATABLE_ORDER_TYPES.has(order.orderType)) return null;
  return order.orderType === "limit" ? "limit" : "trigger";
}

export function isFlashOrderUpdatable(order: { orderType: FlashOrderType; status: FlashOrderStatus }): boolean {
  return FLASH_UPDATABLE_STATUSES.has(order.status) && flashUpdateAxis(order) !== null;
}

// Mirror of triggerPriceOf for the limit axis. Flash does allow a limit
// update to switch basis freely, but Skopos deliberately does not: the user
// reads the current price in whatever basis the order carries and types a
// replacement in that same frame, so re-sending it under a different basis
// would silently reinterpret their number. Restating in the order's own basis
// is the only reading that matches what they were looking at.
export function limitPriceOf(
  order: { limitNotionalPrice: string | null; limitCrossPrice: string | null },
): { price: string; basis: FlashPriceBasis } | null {
  if (order.limitNotionalPrice) return { price: order.limitNotionalPrice, basis: "notional" };
  if (order.limitCrossPrice) return { price: order.limitCrossPrice, basis: "cross" };
  return null;
}

// ── Update (reprice) — PATCH /orders/{orderId} ───────────────────────────────
// Moves a resting order's limit price or trigger threshold without cancelling
// it: Flash re-places the unfilled remainder under the SAME orderId, keeping
// settled partial fills and the original token approval. Same gasless
// signed-message shape as cancel above, with three differences that are easy
// to get wrong and are all enforced below:
//
//   1. The header carries NO "v1" — it is "Definitive Flash — Update Order",
//      where cancel is "Definitive Flash v1 — Cancel Order". Flash validates
//      the bytes exactly, so copying the cancel header yields a 404.
//   2. An "Issued At:" RFC3339 stamp must be within 1 minute of server time.
//      It is what stops a captured signature being replayed later to revert a
//      newer price, so the message has to be built immediately before signing.
//   3. Every decimal must be byte-identical to the value in the request body
//      ("4000", never "4000.0" — no normalization is applied server-side).
//      buildFlashUpdate() below returns the message and the body together from
//      one normalized string so the two can never drift apart.

const FLASH_UPDATE_HEADER = "Definitive Flash — Update Order";

// Accepts what a user actually types — "$3,200", " 3200 " — and returns the
// single canonical string used for BOTH the signed message and the request
// body. Returns null for anything that isn't a positive decimal, so a bad
// input is refused before a wallet prompt rather than after a 4xx.
//
// Commas are only stripped from well-formed thousands grouping, never
// blindly. A blanket strip reads "3,2" — how most of continental Europe
// writes 3.2 — as 32, a silent 10x on a price the user is about to sign.
// Anything that isn't unambiguous is refused so the UI can ask instead.
const PLAIN_DECIMAL_RE   = /^\d+(?:\.\d+)?$/;
const GROUPED_DECIMAL_RE = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

export function normalizeFlashPrice(raw: string): string | null {
  const trimmed = raw.trim().replace(/^\$/, "").trim();
  let cleaned: string;
  if (PLAIN_DECIMAL_RE.test(trimmed)) cleaned = trimmed;
  else if (GROUPED_DECIMAL_RE.test(trimmed)) cleaned = trimmed.replace(/,/g, "");
  else return null;
  if (parseFloat(cleaned) <= 0) return null;
  return cleaned;
}

export interface FlashUpdateLimit {
  price: string;
  basis: FlashPriceBasis;
}

export interface FlashUpdateTrigger {
  price: string;
  basis: FlashPriceBasis;
  triggerType: "upper" | "lower";
}

export interface FlashUpdateRequest {
  limitNotionalPrice?: string;
  limitCrossPrice?: string;
  trigger?: FlashPriceTrigger;
  updateMessage: string;
  userSignature: string;
}

const BASIS_WORD: Record<FlashPriceBasis, string> = { notional: "Notional", cross: "Cross" };
const DIRECTION_WORD: Record<"upper" | "lower", string> = { upper: "Upper", lower: "Lower" };

// The signed message and the body it must match, built together. `issuedAt`
// is injectable purely so tests can pin it; callers pass nothing and get
// "now", which is what the freshness window requires.
export function buildFlashUpdate(params: {
  orderId: string;
  limit?: FlashUpdateLimit;
  trigger?: FlashUpdateTrigger;
  issuedAt?: string;
}): { updateMessage: string; body: Omit<FlashUpdateRequest, "userSignature"> } | null {
  const { orderId, limit, trigger } = params;
  // At least one value, or there is nothing to sign and Flash 422s.
  if (!limit && !trigger) return null;

  const issuedAt = params.issuedAt ?? new Date().toISOString();
  const lines = [FLASH_UPDATE_HEADER, `Order: ${orderId}`, `Issued At: ${issuedAt}`];

  // Limit line always precedes the trigger line when both are present.
  if (limit) lines.push(`Limit ${BASIS_WORD[limit.basis]} Price: ${limit.price}`);
  if (trigger) {
    lines.push(`Trigger ${DIRECTION_WORD[trigger.triggerType]} ${BASIS_WORD[trigger.basis]} Price: ${trigger.price}`);
  }

  const body: Omit<FlashUpdateRequest, "userSignature"> = { updateMessage: lines.join("\n") };
  if (limit) {
    if (limit.basis === "notional") body.limitNotionalPrice = limit.price;
    else body.limitCrossPrice = limit.price;
  }
  if (trigger) {
    body.trigger = {
      triggerType: trigger.triggerType,
      ...(trigger.basis === "notional" ? { notionalPrice: trigger.price } : { crossPrice: trigger.price }),
    };
  }
  return { updateMessage: body.updateMessage, body };
}
