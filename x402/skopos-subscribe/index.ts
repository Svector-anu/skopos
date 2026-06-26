// Bankr x402 Cloud handler — deployed to x402.bankr.bot, not part of the Next app.
// Bankr wraps the payment layer: this runs only after a USDC-on-Base payment is
// verified, and the payment settles only if we return < 400. So a 2xx here means
// a real payment happened. We grant a 30-day Smart subscription by writing
// sub:<wallet> to the SAME Upstash the app's isEntitled() reads.
//
// Bankr does not hand the handler the verified payer, so the paywall sends the
// connected wallet in the body (that wallet is the signer). We still prefer a
// payer header if Bankr ever provides one. Returning >= 400 when we can't apply
// the grant means the caller is never charged for nothing.

const SECONDS_PER_DAY = 86_400;
const SUB_DAYS = 30;

async function upstash(command: string[]): Promise<unknown> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("store not configured");
  const res = await fetch(`${url}/${command.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`store ${res.status}`);
  const json = (await res.json()) as { result?: unknown };
  return json.result;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ error: "POST required" }, { status: 405 });
  }

  let bodyWallet: string | undefined;
  try {
    const body = (await req.json()) as { wallet?: unknown };
    if (typeof body?.wallet === "string") bodyWallet = body.wallet;
  } catch {
    // no JSON body — fall through to header/validation
  }

  const headerPayer = req.headers.get("x-payment-payer") ?? req.headers.get("x-payer");
  const wallet = (headerPayer ?? bodyWallet ?? "").toLowerCase();

  if (!/^0x[a-f0-9]{40}$/.test(wallet)) {
    return Response.json({ error: "Missing or invalid wallet." }, { status: 400 });
  }

  const now = Math.floor(Date.now() / 1000);
  const key = `sub:${wallet}`;

  try {
    const current = Number((await upstash(["get", key])) ?? 0);
    const base = Number.isFinite(current) && current > now ? current : now;
    const expiry = base + SUB_DAYS * SECONDS_PER_DAY;
    await upstash(["setex", key, String(expiry - now), String(expiry)]);
    return Response.json({ ok: true, wallet, expiry });
  } catch (err) {
    // Store write failed — return 5xx so Bankr does NOT settle the payment.
    return Response.json(
      { error: "Could not record subscription.", detail: err instanceof Error ? err.message : "unknown" },
      { status: 502 },
    );
  }
}
