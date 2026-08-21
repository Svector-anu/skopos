// Pure half of the streaming-quote proxy: frame types and the classification
// of what arrives on the wire. Split from the route for the same reason
// lib/flashUpdate.ts is split from lib/flash.ts — the shapes are testable
// without opening a socket, and the route keeps only the plumbing.
//
// Flash streams revised quotes for ONE market order over a WebSocket
// (wss://flash.definitive.fi/v1/ws, "quotes" channel). Each revision fully
// replaces the last and carries its own quoteId and signing payloads, so only
// the newest is ever submittable.

export type FlashStreamFrame =
  | { channel: "quotes"; type: "quote"; subscriptionId: string; quote: unknown }
  | { channel: "quotes"; type: "quote_expired"; subscriptionId: string; reason: QuoteExpiredReason; orderId?: string }
  | { channel: "subscriptions"; type: "ack"; subscriptions: string[] }
  | { channel: "heartbeats"; type: "heartbeat"; counter: number; timestamp: string }
  | { type: "error"; code: string; message?: string; subscriptionId?: string };

export type QuoteExpiredReason = "consumed" | "ttl" | "unsubscribed" | "error";

// What the browser is told. Deliberately narrower than Flash's frame set —
// acks and heartbeats are connection bookkeeping the client cannot act on, so
// they are consumed by the proxy rather than forwarded as noise.
export type ProxyEvent =
  | { event: "quote"; quote: unknown }
  | { event: "expired"; reason: QuoteExpiredReason; orderId?: string }
  | { event: "error"; code: string; message?: string };

// Codes Flash rejects a SUBSCRIBE with. These leave the socket usable and are
// never followed by quote_expired, so the proxy must close the stream itself
// rather than waiting for a terminal frame that will not arrive.
const SUBSCRIBE_TIME_ERRORS = new Set([
  "INVALID_REQUEST", "DUPLICATE_SUBSCRIPTION", "SUBSCRIPTION_LIMIT",
  "VAULT_CREATION_FAILED", "SUBSCRIBE_FAILED", "UNAUTHORIZED",
  "CONNECTION_LIMIT", "BAD_JSON",
]);

export function isTerminalError(code: string): boolean {
  return SUBSCRIBE_TIME_ERRORS.has(code);
}

/**
 * Maps one Flash frame to what the browser should see, or null to swallow it.
 *
 * The subscriptionId check matters: one socket can carry several
 * subscriptions, and a frame for someone else's session must never be
 * forwarded into this response.
 */
export function toProxyEvent(frame: FlashStreamFrame, subscriptionId: string): ProxyEvent | null {
  if ("channel" in frame && frame.channel === "quotes") {
    if (frame.subscriptionId !== subscriptionId) return null;
    if (frame.type === "quote") return { event: "quote", quote: frame.quote };
    if (frame.type === "quote_expired") {
      return { event: "expired", reason: frame.reason, ...(frame.orderId ? { orderId: frame.orderId } : {}) };
    }
    return null;
  }
  // Errors may or may not carry a subscriptionId — a connection-level failure
  // (UNAUTHORIZED, BAD_JSON) has none and still ends this stream.
  if (!("channel" in frame) && frame.type === "error") {
    if (frame.subscriptionId && frame.subscriptionId !== subscriptionId) return null;
    return { event: "error", code: frame.code, ...(frame.message ? { message: frame.message } : {}) };
  }
  // ack / heartbeat — liveness bookkeeping, nothing for the client to do.
  return null;
}

// Whether this event ends the stream. quote_expired is the authoritative end
// signal per Flash's docs; a subscribe-time error is terminal for us because
// no quote_expired follows it.
export function isStreamOver(event: ProxyEvent): boolean {
  return event.event === "expired" || (event.event === "error" && isTerminalError(event.code));
}

// Flash rejects anything else on this channel, so it is refused before a
// socket is opened rather than after.
export function streamableQuoteRequest(body: {
  orderType?: unknown;
  targetChain?: unknown;
  contraChain?: unknown;
}): { ok: true } | { ok: false; reason: string } {
  if (body.orderType !== "market") {
    return { ok: false, reason: "Streaming quotes cover market orders only." };
  }
  if (!body.targetChain || body.targetChain !== body.contraChain) {
    return { ok: false, reason: "Streaming quotes are same-chain only." };
  }
  return { ok: true };
}

export function sseFrame(event: ProxyEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// ── client side ──────────────────────────────────────────────────────────────
// EventSource cannot POST, and the quote request is a body rather than a query
// string, so the browser reads the SSE stream off fetch() instead. That means
// framing it by hand: SSE frames are separated by a blank line and can arrive
// split across chunks.

export interface SseParseState {
  /** Bytes seen but not yet terminated by a blank line. */
  buffer: string;
}

/**
 * Feeds one chunk in, returns whatever complete events it completed. The
 * leftover partial frame stays in `state.buffer` for the next chunk — a
 * revision split across a TCP boundary must not be dropped or double-read.
 */
export function pushSseChunk(state: SseParseState, chunk: string): ProxyEvent[] {
  state.buffer += chunk;
  const events: ProxyEvent[] = [];
  let boundary = state.buffer.indexOf("\n\n");
  while (boundary !== -1) {
    const frame = state.buffer.slice(0, boundary);
    state.buffer = state.buffer.slice(boundary + 2);
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        events.push(JSON.parse(line.slice(5).trim()) as ProxyEvent);
      } catch {
        // A malformed frame is dropped rather than ending a live session.
      }
    }
    boundary = state.buffer.indexOf("\n\n");
  }
  return events;
}

// Only these fields differ between revisions of one quote session — the
// request is fixed, so chains, assets, side and qty never move. Patching just
// these keeps the card's identity stable while guaranteeing the signing
// payload always belongs to the quote currently on screen.
export interface QuoteRevisionPatch {
  quoteId: string;
  orderTypedData: string;
  permitTypedData: string;
  approveTx: { to: string; data: string } | null;
  outputAmount: string | null;
  feesUSD: string | null;
}

type RawQuote = {
  quoteId?: unknown;
  evm?: { orderTypedData?: unknown; permitTypedData?: unknown; approveTx?: unknown } | null;
  to?: { amount?: unknown } | null;
  fees?: { estimatedFeeNotional?: unknown } | null;
};

/**
 * Extracts the revision patch from a raw Flash quote, or null if the frame is
 * missing a signable payload — a quote we cannot sign must never replace one
 * we can.
 */
export function toQuoteRevision(raw: unknown): QuoteRevisionPatch | null {
  if (!raw || typeof raw !== "object") return null;
  const q = raw as RawQuote;
  const quoteId = typeof q.quoteId === "string" ? q.quoteId : null;
  const orderTypedData = typeof q.evm?.orderTypedData === "string" ? q.evm.orderTypedData : null;
  if (!quoteId || !orderTypedData) return null;

  const approve = q.evm?.approveTx as { to?: unknown; data?: unknown } | null | undefined;
  return {
    quoteId,
    orderTypedData,
    permitTypedData: typeof q.evm?.permitTypedData === "string" ? q.evm.permitTypedData : "",
    approveTx:
      approve && typeof approve.to === "string" && typeof approve.data === "string"
        ? { to: approve.to, data: approve.data }
        : null,
    outputAmount: typeof q.to?.amount === "string" ? q.to.amount : null,
    feesUSD: typeof q.fees?.estimatedFeeNotional === "string" ? q.fees.estimatedFeeNotional : null,
  };
}
