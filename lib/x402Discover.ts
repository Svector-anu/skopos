import dns from "node:dns/promises";
import net from "node:net";

// Server-side discovery probe for an arbitrary, user-supplied x402 endpoint —
// "check https://some-endpoint.com" in chat. Free: this only triggers the 402
// challenge to read price/description, it never pays. The actual paid call
// happens client-side with the USER'S OWN wallet (lib/x402GenericClient.ts,
// X402CheckDisplay in app/app/page.tsx) — Skopos's own agent wallet never touches
// this path, on purpose (see docs/paid-data-sources.md: everything Skopos itself
// pays for is a specific, hardcoded, reviewed source, never an arbitrary URL).
//
// Because this is a server-side fetch to a URL the caller doesn't control, it's
// a textbook SSRF surface — resolve the hostname and reject private/loopback/
// link-local addresses (including the 169.254.169.254 cloud metadata address)
// before ever making the request, and never follow redirects (a redirect could
// point from an allowed host to an internal one after the check already passed).

const FETCH_TIMEOUT_MS = 8_000;
const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local — includes cloud metadata IPs
    if (a === 0) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
}

async function assertSafeUrl(urlStr: string): Promise<void> {
  const parsed = new URL(urlStr);
  if (parsed.protocol !== "https:") throw new Error("Only https:// endpoints are supported.");
  if (BLOCKED_HOSTNAMES.has(parsed.hostname.toLowerCase())) throw new Error("This host isn't allowed.");
  const addresses = await dns.lookup(parsed.hostname, { all: true });
  if (addresses.length === 0) throw new Error("Couldn't resolve this host.");
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error("This endpoint resolves to a private or internal address, which isn't allowed.");
    }
  }
}

export interface X402Discovery {
  ok: boolean;
  description?: string;
  network?: string;
  priceUsd?: string;
  asset?: string;
  payTo?: string;
  error?: string;
}

export async function discoverX402Endpoint(url: string, method: "GET" | "POST" = "GET"): Promise<X402Discovery> {
  try {
    await assertSafeUrl(url);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "This URL isn't allowed." };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      redirect: "manual", // never follow — a redirect could retarget an internal address
      headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
      body: method === "POST" ? "{}" : undefined,
      signal: controller.signal,
    });
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, error: "This endpoint redirected — redirects aren't followed for safety." };
    }
    if (res.status !== 402) {
      return {
        ok: false,
        error: res.ok
          ? "This endpoint doesn't require payment — nothing to discover."
          : `Unexpected response (${res.status}).`,
      };
    }
    const header = res.headers.get("payment-required") ?? res.headers.get("www-authenticate");
    if (!header) return { ok: false, error: "No payment challenge found in the response." };

    let decoded: { resource?: { description?: string }; accepts?: Array<{ network?: string; amount?: string; asset?: string; payTo?: string }> };
    try {
      decoded = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
    } catch {
      return { ok: false, error: "Couldn't parse the payment challenge." };
    }

    const accept = decoded.accepts?.[0];
    if (!accept) return { ok: false, error: "Payment challenge had no accepted payment method." };

    // Every x402 endpoint observed this session prices in 6-decimal USDC — assume
    // that for display; if it's ever a different asset, show the raw amount+asset
    // instead of a wrong dollar figure.
    const amountRaw = Number(accept.amount ?? 0);
    const priceUsd = amountRaw > 0 ? String(amountRaw / 1_000_000) : undefined;

    return {
      ok: true,
      description: decoded.resource?.description,
      network: accept.network,
      priceUsd,
      asset: accept.asset,
      payTo: accept.payTo,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Couldn't reach this endpoint." };
  } finally {
    clearTimeout(timer);
  }
}
