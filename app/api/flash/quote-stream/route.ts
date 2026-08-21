import { NextRequest } from "next/server";
import { flashApiKey } from "@/lib/flash";
import {
  streamableQuoteRequest, toProxyEvent, isStreamOver, sseFrame,
  type FlashStreamFrame, type ProxyEvent,
} from "@/lib/flashQuoteStream";
import { checkRateLimit, trustedIp } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
// A quote session lives ~120s. Anything shorter cuts the stream mid-review and
// the client falls back to polling — correct, but it wastes the session.
export const maxDuration = 130;

// WebSocket→SSE proxy. Flash authenticates in-band — the API key rides in
// every subscribe frame — so the browser can never hold this socket itself
// without leaking the key. Same reason /api/flash/submit exists: the socket
// is opened server-side and only quote frames are forwarded on.
//
// SSE rather than a WebSocket back to the browser because the traffic is
// strictly one-directional (revisions out, nothing in) and EventSource
// reconnects on its own. The client submits through the ordinary REST path.
//
// Cost note: this holds a serverless function open for the life of the
// session, so it is rate-limited harder than the REST routes and the socket
// is closed the moment the client goes away — an abandoned session would
// otherwise hold a slot against Flash's per-key connection limit.
const FLASH_WS_URL = "wss://flash.definitive.fi/v1/ws";
const SESSION_MS = 125_000;

export async function POST(req: NextRequest) {
  if (!checkRateLimit("flash-stream", trustedIp(req), 5)) {
    return Response.json({ error: "Too many quote streams — slow down." }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const streamable = streamableQuoteRequest(body);
  if (!streamable.ok) {
    return Response.json({ error: streamable.reason }, { status: 400 });
  }

  const subscriptionId = `q-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let ws: WebSocket | null = null;
      let ttlTimer: ReturnType<typeof setTimeout> | null = null;

      // Single exit path: every close route (terminal frame, socket error,
      // client disconnect, TTL) funnels here, so the socket cannot outlive
      // the response and the controller cannot be closed twice.
      const shutdown = (final?: ProxyEvent) => {
        if (closed) return;
        closed = true;
        if (ttlTimer) clearTimeout(ttlTimer);
        try { if (final) controller.enqueue(encoder.encode(sseFrame(final))); } catch { /* already closed */ }
        try { ws?.close(); } catch { /* already closed */ }
        try { controller.close(); } catch { /* already closed */ }
      };

      // The client going away is the common case — a user closing the quote
      // card. Without this the socket would sit until Flash's own TTL.
      req.signal.addEventListener("abort", () => shutdown());

      try {
        ws = new WebSocket(FLASH_WS_URL);
      } catch {
        shutdown({ event: "error", code: "SUBSCRIBE_FAILED", message: "Could not open the quote stream." });
        return;
      }

      ws.onopen = () => {
        // Heartbeats keep the socket alive through intermediaries that close
        // idle connections, and make a dead-but-quiet connection detectable.
        ws?.send(JSON.stringify({ channel: "heartbeats", type: "subscribe", apiKey: flashApiKey() }));
        ws?.send(JSON.stringify({
          channel: "quotes", type: "subscribe", subscriptionId, apiKey: flashApiKey(), request: body,
        }));
      };

      ws.onmessage = (raw: MessageEvent) => {
        let frame: FlashStreamFrame;
        try {
          frame = JSON.parse(typeof raw.data === "string" ? raw.data : String(raw.data)) as FlashStreamFrame;
        } catch {
          return; // unparseable frame — ignore rather than kill a live session
        }
        const event = toProxyEvent(frame, subscriptionId);
        if (!event) return;
        try {
          controller.enqueue(encoder.encode(sseFrame(event)));
        } catch {
          shutdown();
          return;
        }
        if (isStreamOver(event)) shutdown();
      };

      ws.onerror = () => {
        shutdown({ event: "error", code: "STREAM_ERROR", message: "The quote stream dropped." });
      };

      ws.onclose = () => shutdown();

      // Flash ends a session at ~120s with quote_expired. This is the backstop
      // for a socket that goes silent without sending one — the function must
      // not be held open past its own maxDuration.
      ttlTimer = setTimeout(() => shutdown({ event: "expired", reason: "ttl" }), SESSION_MS);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
    },
  });
}
