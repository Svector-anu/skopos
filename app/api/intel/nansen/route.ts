import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const NANSEN_BASE = "https://api.nansen.ai/api/v1";
// Full endpoint paths (relative to /api/v1). Token God Mode "who-bought-sold" is
// token-scoped — the only smart-money endpoint that answers "is smart money
// accumulating or exiting THIS token". Locked to a whitelist so the proxy can't
// be used as an open relay.
const ALLOWED_ENDPOINTS = new Set(["tgm/who-bought-sold"]);
const TIMEOUT_MS = 60_000; // paid retry triggers on-chain settlement, which can exceed 12s

// Headers Nansen's x402 flow needs the browser client to read on the way back.
const PASSTHROUGH_RESPONSE_HEADERS = [
  "payment-required",
  "payment-response",
  "x-payment-response",
  "payment-receipt",
  "www-authenticate",
  "content-type",
];

// x402 v2 carries the signed payment in Payment-Signature; v1 used X-Payment.
// Forward whichever the client sent (Nansen expects Payment-Signature).
const PAYMENT_REQUEST_HEADERS = ["payment-signature", "x-payment"];

// Same-origin transparent proxy to Nansen smart-money endpoints. The browser
// runs the x402 client (wrapFetchWithPayment) against THIS route, so the user's
// wallet signs the payment and CORS is avoided. This proxy only forwards — it
// never holds keys or funds. Locked to the smart-money endpoint whitelist so it
// can't be used as an open relay.
export async function POST(req: NextRequest) {
  let endpoint: string;
  let body: unknown;
  try {
    const parsed = await req.json();
    endpoint = String(parsed.endpoint ?? "");
    body = parsed.body ?? {};
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!ALLOWED_ENDPOINTS.has(endpoint)) {
    return Response.json({ error: "Unsupported smart-money endpoint." }, { status: 400 });
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let hasPayment = false;
  for (const h of PAYMENT_REQUEST_HEADERS) {
    const v = req.headers.get(h);
    if (v) { headers[h] = v; hasPayment = true; }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(`${NANSEN_BASE}/${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    console.error(`[nansen-proxy] fetch threw (paid=${hasPayment}):`, err instanceof Error ? `${err.name}: ${err.message}` : err);
    return Response.json({ error: "Nansen upstream unavailable." }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }

  console.log(`[nansen-proxy] ${endpoint} -> ${upstream.status} (paid=${hasPayment})`);

  const responseHeaders = new Headers();
  for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }

  const payload = await upstream.arrayBuffer();
  if (upstream.status === 402 && hasPayment) {
    console.error("[nansen-proxy] paid request rejected:", new TextDecoder().decode(payload).slice(0, 400));
  }
  return new Response(payload, { status: upstream.status, headers: responseHeaders });
}
