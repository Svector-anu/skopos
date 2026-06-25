import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const NANSEN_BASE = "https://api.nansen.ai/api/v1/smart-money";
const ALLOWED_ENDPOINTS = new Set(["holdings", "netflow", "dex-trades", "inflows"]);
const TIMEOUT_MS = 12_000;

// Headers Nansen's x402 flow needs the browser client to read on the way back.
const PASSTHROUGH_RESPONSE_HEADERS = [
  "payment-required",
  "payment-response",
  "payment-receipt",
  "www-authenticate",
  "content-type",
];

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
  const payment = req.headers.get("x-payment");
  if (payment) headers["X-Payment"] = payment;

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
  } catch {
    return Response.json({ error: "Nansen upstream unavailable." }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }

  const responseHeaders = new Headers();
  for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }

  const payload = await upstream.arrayBuffer();
  return new Response(payload, { status: upstream.status, headers: responseHeaders });
}
