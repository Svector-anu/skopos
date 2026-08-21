import { describe, expect, it } from "vitest";
import {
  toProxyEvent, isStreamOver, isTerminalError, streamableQuoteRequest, sseFrame,
  type FlashStreamFrame,
} from "@/lib/flashQuoteStream";

const SUB = "q-abc";
const OTHER = "q-someone-else";

describe("toProxyEvent", () => {
  it("should forward a quote revision for this subscription", () => {
    // #given a quote frame for our own session
    const frame = { channel: "quotes", type: "quote", subscriptionId: SUB, quote: { quoteId: "q1" } } as FlashStreamFrame;

    // #when it is mapped
    const out = toProxyEvent(frame, SUB);

    // #then the quote reaches the client
    expect(out).toEqual({ event: "quote", quote: { quoteId: "q1" } });
  });

  it("should never forward a frame belonging to another subscription", () => {
    // #given a quote for a different session on the same socket
    const frame = { channel: "quotes", type: "quote", subscriptionId: OTHER, quote: { quoteId: "leak" } } as FlashStreamFrame;

    // #when it is mapped
    const out = toProxyEvent(frame, SUB);

    // #then it is dropped — one socket can carry several sessions, and
    // forwarding someone else's quote would let the wrong order be signed
    expect(out).toBeNull();
  });

  it("should forward the terminal expiry with its reason", () => {
    // #given the session ending because an order was submitted against it
    const frame = { channel: "quotes", type: "quote_expired", subscriptionId: SUB, reason: "consumed", orderId: "o-1" } as FlashStreamFrame;

    // #when it is mapped
    const out = toProxyEvent(frame, SUB);

    // #then reason and orderId both reach the client
    expect(out).toEqual({ event: "expired", reason: "consumed", orderId: "o-1" });
  });

  it("should omit orderId when the expiry carries none", () => {
    // #given a TTL expiry, which has no resulting order
    const frame = { channel: "quotes", type: "quote_expired", subscriptionId: SUB, reason: "ttl" } as FlashStreamFrame;

    // #when it is mapped
    const out = toProxyEvent(frame, SUB);

    // #then no empty orderId is invented
    expect(out).toEqual({ event: "expired", reason: "ttl" });
  });

  it("should forward a connection-level error that carries no subscriptionId", () => {
    // #given UNAUTHORIZED, which is not scoped to a session
    const frame = { type: "error", code: "UNAUTHORIZED", message: "bad key" } as FlashStreamFrame;

    // #when it is mapped
    const out = toProxyEvent(frame, SUB);

    // #then it still ends our stream rather than being dropped as unmatched
    expect(out).toEqual({ event: "error", code: "UNAUTHORIZED", message: "bad key" });
  });

  it("should drop an error scoped to another subscription", () => {
    // #given an error for a different session
    const frame = { type: "error", code: "INVALID_REQUEST", subscriptionId: OTHER } as FlashStreamFrame;

    // #when it is mapped
    const out = toProxyEvent(frame, SUB);

    // #then our stream is unaffected
    expect(out).toBeNull();
  });

  it("should swallow acks and heartbeats", () => {
    // #given connection bookkeeping the client cannot act on
    const frames = [
      { channel: "subscriptions", type: "ack", subscriptions: ["quotes"] },
      { channel: "heartbeats", type: "heartbeat", counter: 1, timestamp: "2026-01-01T00:00:00.000Z" },
    ] as FlashStreamFrame[];

    // #when each is mapped
    const out = frames.map(f => toProxyEvent(f, SUB));

    // #then neither is forwarded as noise
    expect(out).toEqual([null, null]);
  });
});

describe("isStreamOver", () => {
  it("should end the stream on any expiry", () => {
    // #given the authoritative end signal
    // #when checked
    const out = isStreamOver({ event: "expired", reason: "ttl" });

    // #then the proxy closes
    expect(out).toBe(true);
  });

  it("should end the stream on a subscribe-time error", () => {
    // #given a refusal that is NOT followed by quote_expired
    const out = isStreamOver({ event: "error", code: "SUBSCRIPTION_LIMIT" });

    // #then the proxy closes itself rather than waiting for a frame that
    // will never arrive
    expect(out).toBe(true);
  });

  it("should keep the stream open on a quote", () => {
    // #given an ordinary revision
    const out = isStreamOver({ event: "quote", quote: {} });

    // #then the session continues
    expect(out).toBe(false);
  });

  it("should treat an unknown error code as non-terminal", () => {
    // #given a code Flash has not documented
    const out = isTerminalError("SOMETHING_NEW");

    // #then we wait for quote_expired rather than closing a live session on
    // a code we do not understand
    expect(out).toBe(false);
  });
});

describe("streamableQuoteRequest", () => {
  it("should accept a same-chain market request", () => {
    // #given the only shape Flash streams
    const out = streamableQuoteRequest({ orderType: "market", targetChain: "base", contraChain: "base" });

    // #then it is allowed through
    expect(out).toEqual({ ok: true });
  });

  it("should refuse a non-market order before opening a socket", () => {
    // #given a limit order
    const out = streamableQuoteRequest({ orderType: "limit", targetChain: "base", contraChain: "base" });

    // #then it is refused locally rather than costing a connection
    expect(out.ok).toBe(false);
  });

  it("should refuse a cross-chain request", () => {
    // #given differing chains
    const out = streamableQuoteRequest({ orderType: "market", targetChain: "base", contraChain: "arbitrum" });

    // #then it is refused — Flash rejects these with INVALID_REQUEST
    expect(out.ok).toBe(false);
  });

  it("should refuse a request with no chain at all", () => {
    // #given a body missing the chains, where undefined === undefined would
    // otherwise read as "same chain"
    const out = streamableQuoteRequest({ orderType: "market" });

    // #then it is still refused
    expect(out.ok).toBe(false);
  });
});

describe("sseFrame", () => {
  it("should emit a well-formed SSE data frame", () => {
    // #given a proxy event
    const out = sseFrame({ event: "expired", reason: "ttl" });

    // #then it carries the data: prefix and the blank-line terminator
    expect(out).toBe('data: {"event":"expired","reason":"ttl"}\n\n');
  });
});
