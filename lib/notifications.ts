import webpush from "web-push";
import { getRedis } from "./redis";

// Web Push delivery — the notification channel for watchers (lib/watchers.ts).
// Chosen over Telegram/email as the FIRST channel because it needs zero new
// external account: VAPID keys are a self-generated keypair (`npx web-push
// generate-vapid-keys`), not a signup. Trade-off: only reaches a user who has
// opened the Skopos web app at least once and granted notification permission
// — headless clients (iMessage/Telegram/MCP) can't hold a push subscription.
// A Telegram channel can be added later against the same watcher registry.

const SUB_KEY_PREFIX = "push:sub:"; // + identity (wallet or anonId)

let vapidConfigured = false;
function ensureVapid(): boolean {
  const pub  = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  if (!vapidConfigured) {
    webpush.setVapidDetails("https://www.tryskopos.xyz", pub, priv);
    vapidConfigured = true;
  }
  return true;
}

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

// One subscription per identity — a fresh subscribe overwrites the previous
// one (covers the common case of re-granting permission in a new browser).
export async function saveSubscription(identity: string, sub: PushSubscriptionRecord): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  await redis.set(`${SUB_KEY_PREFIX}${identity}`, JSON.stringify(sub));
  return true;
}

export async function getSubscription(identity: string): Promise<PushSubscriptionRecord | null> {
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.get<string>(`${SUB_KEY_PREFIX}${identity}`);
  if (!raw) return null;
  try { return JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as PushSubscriptionRecord; }
  catch { return null; }
}

export interface NotifyPayload {
  title: string;
  body: string;
  url?: string;
}

// Fails open/silent — a dead subscription (user revoked permission, browser
// data cleared) is an expected steady-state, not an error worth surfacing to
// the cron loop that calls this for every watcher.
export async function sendNotification(identity: string, payload: NotifyPayload): Promise<boolean> {
  if (!ensureVapid()) return false;
  const sub = await getSubscription(identity);
  if (!sub) return false;
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      JSON.stringify(payload)
    );
    return true;
  } catch {
    return false;
  }
}
