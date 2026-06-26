// Same-origin x402 proxy for the Smart subscription purchase.
//
// Bankr x402 Cloud gates the CORS preflight (OPTIONS returns 402/404, never a
// 2xx), so a browser cannot call x402.bankr.bot directly — the preflight fails
// before any payment. The wallet still signs the EIP-3009 USDC authorization
// client-side; this route only relays the HTTP exchange server-side, where there
// is no preflight. Non-custodial is preserved: we never hold keys, we forward the
// user's signed X-PAYMENT header verbatim.
//
// Flow: client POSTs {wallet} → we relay to Bankr → 402 challenge comes back →
// client signs, retries with X-PAYMENT → we relay → Bankr settles, the handler
// grants sub:<wallet> in Upstash → we relay the 2xx back.

const UPSTREAM = process.env.SUBSCRIBE_UPSTREAM_URL;

// Headers worth forwarding from the browser to Bankr. The signed authorization
// rides on the retry in a payment header — @x402/fetch v2 names it
// `payment-signature` (not the older `X-PAYMENT`), so forward anything with
// "payment" in the name; the rest keep the request well-formed.
function pickRequestHeaders(src: Headers): Headers {
  const out = new Headers();
  const ct = src.get("content-type");
  if (ct) out.set("content-type", ct);
  const accept = src.get("accept");
  if (accept) out.set("accept", accept);
  for (const [key, value] of src) {
    if (key.toLowerCase().includes("payment")) out.set(key, value);
  }
  return out;
}

// Relay the upstream status + body, passing through x402/payment headers the
// client lib reads (payment-required challenge, payment-response receipt).
function pickResponseHeaders(src: Headers): Headers {
  const out = new Headers();
  for (const [key, value] of src) {
    const k = key.toLowerCase();
    if (k === "content-type" || k.includes("payment") || k === "www-authenticate") {
      out.set(key, value);
    }
  }
  return out;
}

export async function POST(req: Request): Promise<Response> {
  if (!UPSTREAM) {
    return Response.json({ error: "Subscriptions are not enabled yet." }, { status: 503 });
  }

  const body = await req.arrayBuffer();

  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: pickRequestHeaders(req.headers),
      body,
    });
  } catch (err) {
    return Response.json(
      { error: "Subscription service unreachable.", detail: err instanceof Error ? err.message : "unknown" },
      { status: 502 },
    );
  }

  return new Response(await upstream.arrayBuffer(), {
    status: upstream.status,
    headers: pickResponseHeaders(upstream.headers),
  });
}
