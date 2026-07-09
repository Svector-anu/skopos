import { Redis } from "@upstash/redis";

// Smart-tier metering. One increment per submitted Smart message that actually
// reached the gateway. Daily calendar key with a 24h TTL → resets at UTC
// midnight, self-cleaning, no cron. Wallet users get the free daily cap; anon
// users (no wallet) get a small cookie/localStorage-keyed teaser, then a
// connect paywall. Fast tier never touches this module.

const TTL_SECONDS = 60 * 60 * 24;

function envCap(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const FREE_DAILY_CAP   = envCap("SMART_FREE_DAILY_CAP", 20);
const ANON_TEASER_CAP  = envCap("SMART_ANON_TEASER_CAP", 2);

// Agent-path budget. Agents reach Smart through the Vara relay but cannot pay,
// so spend has to be capped against Skopos's prepaid Bankr credits rather than
// metered per wallet. A global ceiling protects the credit pool; a per-handle
// ceiling stops one chatty VAN sender from eating the whole day's budget. Over
// budget → caller degrades to Fast (never refuses), so these are soft caps.
const AGENT_DAILY_CAP        = envCap("SMART_AGENT_DAILY_CAP", 500);
const AGENT_HANDLE_DAILY_CAP = envCap("SMART_AGENT_HANDLE_DAILY_CAP", 50);

// Smart-money intel budget. When Skopos fronts the x402 micropayment (agent-paid
// mode), every reveal spends real USDC from Skopos's wallet, so a global daily
// ceiling protects the wallet from runaway clicks. Soft cap, fail-open like the
// rest of this module — Redis trouble lets reads through rather than breaking.
const INTEL_AGENT_DAILY_CAP  = envCap("SMART_MONEY_AGENT_DAILY_CAP", 200);

// Headless text-mode intel reads (format:"text") spend x402 inline, so they get a
// per-anonId daily cap ON TOP of the global cap. Unlike the rest of this module,
// this one FAILS CLOSED — no anonId or Redis down → deny, so a headless caller can
// never drain the USDC budget when metering is unavailable.
const AGENT_TEXT_INTEL_DAILY_CAP = envCap("AGENT_TEXT_INTEL_DAILY_CAP", 15);

let client: Redis | null = null;
function getRedis(): Redis | null {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  if (!client) client = new Redis({ url, token });
  return client;
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export type MeterIdentity = { wallet?: string | null; anonId?: string | null };
type MeterKey = { key: string; cap: number; anonymous: boolean };

function resolveMeterKey({ wallet, anonId }: MeterIdentity, holderCap?: number | null): MeterKey | null {
  const day = utcDay();
  if (wallet && wallet.startsWith("0x")) {
    const cap = holderCap && holderCap > 0 ? holderCap : FREE_DAILY_CAP;
    return { key: `smart:${wallet.toLowerCase()}:${day}`, cap, anonymous: false };
  }
  if (anonId) {
    return { key: `smart:anon:${anonId}:${day}`, cap: ANON_TEASER_CAP, anonymous: true };
  }
  return null;
}

export type QuotaCheck =
  | { allowed: true; key: string; used: number; cap: number; anonymous: boolean }
  | { allowed: false; reason: "connect" | "daily_cap"; used: number; cap: number };

// Read-only: never increments. The caller increments via incrSmart() only after
// a Smart reply genuinely served, so structural cards and gateway fallbacks to
// Fast don't burn a count.
export async function checkSmartQuota(id: MeterIdentity, holderCap?: number | null): Promise<QuotaCheck> {
  const meter = resolveMeterKey(id, holderCap);
  if (!meter) {
    return { allowed: false, reason: "connect", used: 0, cap: ANON_TEASER_CAP };
  }

  const redis = getRedis();
  if (!redis) {
    console.warn("[usage] Upstash not configured — Smart metering disabled (fail-open)");
    return { allowed: true, key: meter.key, used: 0, cap: meter.cap, anonymous: meter.anonymous };
  }

  try {
    const used = Number((await redis.get<number>(meter.key)) ?? 0);
    if (used >= meter.cap) {
      return { allowed: false, reason: meter.anonymous ? "connect" : "daily_cap", used, cap: meter.cap };
    }
    return { allowed: true, key: meter.key, used, cap: meter.cap, anonymous: meter.anonymous };
  } catch (err) {
    console.error("[usage] quota check failed — fail-open:", err instanceof Error ? err.message : err);
    return { allowed: true, key: meter.key, used: 0, cap: meter.cap, anonymous: meter.anonymous };
  }
}

export async function incrSmart(key: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, TTL_SECONDS);
  } catch (err) {
    console.error("[usage] incr failed:", err instanceof Error ? err.message : err);
  }
}

function agentGlobalKey(day: string): string {
  return `smart:agent:${day}`;
}

function agentHandleKey(handle: string, day: string): string {
  return `smart:agent:${handle.toLowerCase().slice(0, 64)}:${day}`;
}

// Read-only: never increments. Mirrors checkSmartQuota's fail-open contract —
// agents must never be refused, so any Redis trouble lets Smart through and the
// budget simply isn't enforced rather than the request breaking.
export async function checkAgentSmartBudget(handle?: string | null): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    console.warn("[usage] Upstash not configured — agent Smart budget disabled (fail-open)");
    return true;
  }

  const day = utcDay();
  try {
    const global = Number((await redis.get<number>(agentGlobalKey(day))) ?? 0);
    if (global >= AGENT_DAILY_CAP) return false;

    if (handle) {
      const perHandle = Number((await redis.get<number>(agentHandleKey(handle, day))) ?? 0);
      if (perHandle >= AGENT_HANDLE_DAILY_CAP) return false;
    }

    return true;
  } catch (err) {
    console.error("[usage] agent budget check failed — fail-open:", err instanceof Error ? err.message : err);
    return true;
  }
}

export async function incrAgentSmart(handle?: string | null): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const day = utcDay();
  try {
    const global = await redis.incr(agentGlobalKey(day));
    if (global === 1) await redis.expire(agentGlobalKey(day), TTL_SECONDS);

    if (handle) {
      const perHandle = await redis.incr(agentHandleKey(handle, day));
      if (perHandle === 1) await redis.expire(agentHandleKey(handle, day), TTL_SECONDS);
    }
  } catch (err) {
    console.error("[usage] agent incr failed:", err instanceof Error ? err.message : err);
  }
}

function intelGlobalKey(day: string): string {
  return `intel:agent:${day}`;
}

// Read-only: never increments. Fail-closed — these routes are unauthenticated
// and spend Skopos's own wallet on a real x402 payment per successful call, so
// an unenforceable budget (Redis down/unconfigured) must block the spend, not
// allow it. Unlike most fail-open reads in this file, availability is not the
// higher-value tradeoff here.
export async function checkIntelBudget(): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    console.error("[usage] Upstash not configured — intel budget cannot be enforced, failing closed");
    return false;
  }
  try {
    const used = Number((await redis.get<number>(intelGlobalKey(utcDay()))) ?? 0);
    return used < INTEL_AGENT_DAILY_CAP;
  } catch (err) {
    console.error("[usage] intel budget check failed — failing closed:", err instanceof Error ? err.message : err);
    return false;
  }
}

export async function incrIntel(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const day = utcDay();
  try {
    const count = await redis.incr(intelGlobalKey(day));
    if (count === 1) await redis.expire(intelGlobalKey(day), TTL_SECONDS);
  } catch (err) {
    console.error("[usage] intel incr failed:", err instanceof Error ? err.message : err);
  }
}

function agentTextIntelKey(anonId: string, day: string): string {
  return `agenttext:intel:${anonId.slice(0, 64)}:${day}`;
}

// Fail-CLOSED: no anonId or Redis unavailable → deny (don't spend). This is the
// spend guard for headless text-mode intel reads.
export async function checkAgentTextIntelCap(anonId: string | null | undefined): Promise<boolean> {
  if (!anonId) return false;
  const redis = getRedis();
  if (!redis) return false;
  try {
    const used = Number((await redis.get<number>(agentTextIntelKey(anonId, utcDay()))) ?? 0);
    return used < AGENT_TEXT_INTEL_DAILY_CAP;
  } catch (err) {
    console.error("[usage] agent-text intel cap check failed (fail-closed):", err instanceof Error ? err.message : err);
    return false;
  }
}

export async function incrAgentTextIntel(anonId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const day = utcDay();
  try {
    const count = await redis.incr(agentTextIntelKey(anonId, day));
    if (count === 1) await redis.expire(agentTextIntelKey(anonId, day), TTL_SECONDS);
  } catch (err) {
    console.error("[usage] agent-text intel incr failed:", err instanceof Error ? err.message : err);
  }
}
