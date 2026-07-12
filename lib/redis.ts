import { Redis } from "@upstash/redis";

// Shared lazy-singleton Upstash client. Every caller wants the same contract:
// read the same two env vars, return null (not throw) when unconfigured so
// each feature can fail open/closed on its own terms, and share one client
// instance per process rather than one per importing module.
let client: Redis | null = null;

export function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  if (!client) client = new Redis({ url, token });
  return client;
}
