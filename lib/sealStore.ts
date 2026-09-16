import { getRedis } from "./redis";
import type { SealDraft, SealPolicy } from "./seal";
import { SEAL_VERSION, sanitizeTitle } from "./seal";
import type { FlashBracketWire } from "./flashBracket";
import type { FlashSubmitRequest } from "./flash";

// Redis-backed half of Seal. Kept apart from lib/seal.ts for the same reason
// lib/flashBracket.ts is kept apart from lib/flash.ts: the pure half has to be
// importable without dragging @upstash/redis along, and the page that renders a
// Seal only needs types.
//
// Two keys, never written together:
//
//   seal:<id>         the policy. Immutable once written.
//   seal:count:<id>   instantiations. The only thing that changes.
//
// Splitting them is the point. A published policy that could be edited would
// make every open tab a lie, so the record is write-once and an edit publishes
// a NEW id. The counter is the exception that proves it — it lives outside the
// record precisely so incrementing it cannot touch the policy.

const SEAL_KEY_PREFIX  = "seal:";
const COUNT_KEY_PREFIX = "seal:count:";

// 12 hex characters of a v4 UUID: 48 bits of entropy in a URL-safe, unambiguous
// alphabet, and case-insensitive so a Seal link survives being retyped. Not
// lib/watchers.ts's Math.random() pair — that is fine for a private watcher id
// and wrong for something people paste to each other.
const ID_LENGTH = 12;

function newSealId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, ID_LENGTH);
}

export function isSealId(raw: string): boolean {
  return new RegExp(`^[0-9a-f]{${ID_LENGTH}}$`).test(raw);
}

export type SealReadFailure = "not_found" | "unavailable";

export type SealRead =
  | { ok: true;  policy: SealPolicy }
  | { ok: false; reason: SealReadFailure };

/**
 * Reads fail CLOSED.
 *
 * lib/usage.ts sets both precedents — the Smart quota fails open because
 * availability matters more than a counted message, and the intel budget fails
 * closed because it guards real spend. A Seal is the second kind: if the store
 * cannot be reached the honest answer is "couldn't load this Seal", never a
 * default policy and never a silent 404 that reads as "the creator deleted it".
 */
export async function getSeal(id: string): Promise<SealRead> {
  if (!isSealId(id)) return { ok: false, reason: "not_found" };
  const redis = getRedis();
  if (!redis) return { ok: false, reason: "unavailable" };

  let raw: unknown;
  try {
    raw = await redis.get(`${SEAL_KEY_PREFIX}${id}`);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (raw === null || raw === undefined) return { ok: false, reason: "not_found" };

  try {
    // Upstash parses JSON it recognises, so a stored string can come back either
    // already-parsed or raw depending on the value — the same defensive shape
    // lib/watchers.ts uses on its hash reads.
    const policy = (typeof raw === "string" ? JSON.parse(raw) : raw) as SealPolicy;
    return policy && typeof policy === "object" && typeof policy.id === "string"
      ? { ok: true, policy }
      : { ok: false, reason: "not_found" };
  } catch {
    return { ok: false, reason: "not_found" };
  }
}

export type SealWrite =
  | { ok: true;  policy: SealPolicy }
  | { ok: false; reason: "unavailable" };

/**
 * Writes the policy under a fresh id, refusing to overwrite.
 *
 * `nx` is not belt-and-braces: it is what makes "immutable" a property of the
 * store rather than a promise made by its callers. A collision at 48 bits is
 * vanishingly unlikely and retrying is cheaper than reasoning about it.
 */
export async function putSeal(draft: SealDraft): Promise<SealWrite> {
  const redis = getRedis();
  if (!redis) return { ok: false, reason: "unavailable" };

  for (let attempt = 0; attempt < 3; attempt++) {
    const policy: SealPolicy = {
      ...draft,
      title:     sanitizeTitle(draft.title),
      creator:   draft.creator.toLowerCase(),
      id:        newSealId(),
      version:   SEAL_VERSION,
      createdAt: Date.now(),
    };
    try {
      const written = await redis.set(
        `${SEAL_KEY_PREFIX}${policy.id}`,
        JSON.stringify(policy),
        { nx: true },
      );
      if (written) return { ok: true, policy };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }
  return { ok: false, reason: "unavailable" };
}

/**
 * How many wallets have instantiated this Seal.
 *
 * Read never throws — a missing counter reads as zero, because a page that
 * cannot show social proof should still show the policy.
 */
export async function getInstantiationCount(id: string): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;
  try {
    const n = await redis.get<number | string>(`${COUNT_KEY_PREFIX}${id}`);
    const parsed = typeof n === "string" ? Number(n) : n;
    return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

/**
 * Counted at SUBMIT, never at quote.
 *
 * A quote is a look; an order is a use. Counting quotes would make the number
 * meaningless the first time someone opened the page twice, and the number is
 * the only evidence a stranger has that anyone else has trusted this policy.
 */
export async function bumpInstantiations(id: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.incr(`${COUNT_KEY_PREFIX}${id}`);
  } catch {
    // A lost count must never fail an order that already has a signature on it.
    console.error("[seal] instantiation count not recorded for", id);
  }
}

// ── pending orders ───────────────────────────────────────────────────────────
// The order body is built ONCE, at quote time, from the stored policy, and
// parked here under Flash's own quoteId. At submit the browser sends a quoteId
// and a signature and nothing else — so there is no order field a client can
// name, and "what the page displayed" and "what Flash receives" are the same
// bytes rather than two hopefully-identical constructions.
//
// Re-quoting at submit instead would be simpler and wrong: it mints a new
// quoteId, and the user already signed the old one.
//
// The TTL doubles as the quote-freshness rule the app has never had — the chat
// path stamps `quotedAt` on every card and nothing enforces it, and the expiry
// countdown is suppressed on Flash legs entirely. Here, an expired quote has no
// record to submit against, so staleness fails closed on its own.

const PENDING_KEY_PREFIX = "seal:pending:";
// Flash's streamed quote sessions run ~120s; this is that plus room for a user
// reading the card and a wallet prompt.
const PENDING_TTL_SECONDS = 180;

export interface PendingBracket {
  wire:                FlashBracketWire;
  deadline:            string;
  signedMaxFromAmount: string;
  salt:                string | null;
}

export interface PendingSealOrder {
  sealId:        string;
  size:          string;
  funderAddress: string;
  /** Every Flash field except the signatures, derived server-side from the policy. */
  submit:        Omit<FlashSubmitRequest, "userSignature" | "attachedBracket">;
  bracket:       PendingBracket | null;
}

export async function putPendingOrder(quoteId: string, pending: PendingSealOrder): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    await redis.set(`${PENDING_KEY_PREFIX}${quoteId}`, JSON.stringify(pending), { ex: PENDING_TTL_SECONDS });
    return true;
  } catch {
    return false;
  }
}

export async function getPendingOrder(quoteId: string): Promise<PendingSealOrder | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(`${PENDING_KEY_PREFIX}${quoteId}`);
    if (raw === null || raw === undefined) return null;
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as PendingSealOrder;
  } catch {
    return null;
  }
}

/**
 * Dropped only after Flash accepts the order.
 *
 * A failed submit keeps its record so the user can retry the signature they
 * already gave — wallet hiccups are ordinary. A successful one cannot be
 * replayed through this route.
 */
export async function clearPendingOrder(quoteId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(`${PENDING_KEY_PREFIX}${quoteId}`);
  } catch {
    console.error("[seal] pending order not cleared for", quoteId);
  }
}
