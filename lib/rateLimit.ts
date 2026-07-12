// Sliding-window, per-IP rate limiter — in-memory (scoped to one serverless
// instance, not globally shared across the fleet). That's an acceptable
// tradeoff for abuse throttling, not a hard security boundary — the
// Redis-backed daily budgets in lib/usage.ts are the hard limit for paid
// reads. Buckets are namespaced per route family so one route's traffic can't
// exhaust another's allowance.

const WINDOW_MS = 60_000;
const buckets = new Map<string, Map<string, number[]>>();

export function checkRateLimit(bucket: string, ip: string, limit: number): boolean {
  let hitsByIp = buckets.get(bucket);
  if (!hitsByIp) {
    hitsByIp = new Map();
    buckets.set(bucket, hitsByIp);
  }
  const now = Date.now();
  const hits = (hitsByIp.get(ip) ?? []).filter(t => now - t < WINDOW_MS);
  hits.push(now);
  hitsByIp.set(ip, hits);
  return hits.length <= limit;
}

// Rightmost x-forwarded-for entry — the one Vercel's trusted edge proxy adds,
// not an attacker-spoofable earlier entry — with x-real-ip as a fallback.
export function trustedIp(req: { headers: { get(name: string): string | null } }): string {
  const forwardedFor = req.headers.get("x-forwarded-for") ?? "";
  const ips = forwardedFor.split(",").map(s => s.trim()).filter(Boolean);
  return ips[ips.length - 1] ?? req.headers.get("x-real-ip") ?? "unknown";
}

// Only allow the production origin and localhost dev — matches app/api/chat/route.ts's
// existing CORS policy, extracted so paid routes can share it instead of drifting.
const ALLOWED_ORIGINS = new Set(["https://www.tryskopos.xyz", "https://tryskopos.xyz"]);

export function corsHeadersFor(req: { headers: { get(name: string): string | null } }): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const corsOrigin = ALLOWED_ORIGINS.has(origin) ? origin : (origin.startsWith("http://localhost") ? origin : null);
  return corsOrigin ? { "Access-Control-Allow-Origin": corsOrigin, "Vary": "Origin" } : {};
}
