import { Redis } from "@upstash/redis";
import { createPublicClient, http, getAddress } from "viem";
import { base } from "viem/chains";

// $skopos holder gate for the Smart tier. Holding at least SMART_TOKEN_GATE_MIN
// $skopos (whole tokens) raises a wallet's daily Smart cap from the free cap to
// the holder cap — bounded spend, not an uncapped bypass (paid subs get that).
//
// Disabled by default: SMART_TOKEN_GATE_MIN unset or 0 → hasSmartTokenAccess()
// always returns false, so the gate is inert and everyone uses the normal caps.
// Flip it on by setting the env, no code change.
//
// Fails to "no access" on any RPC or Redis error: a holder simply falls back to
// the free cap rather than the request breaking. Never grants access on failure.

const SKOPOS_TOKEN = (process.env.SKOPOS_TOKEN_ADDRESS ?? "0xf6ff51998a5ca004ace94f0035e3b6507ce3aba3") as `0x${string}`;
const TOKEN_DECIMALS = 18;
const CACHE_TTL_SECONDS = 5 * 60;

const BALANCE_OF_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

function gateMinWei(): bigint | null {
  const whole = Number(process.env.SMART_TOKEN_GATE_MIN);
  if (!Number.isFinite(whole) || whole <= 0) return null;
  return BigInt(Math.floor(whole)) * BigInt(10) ** BigInt(TOKEN_DECIMALS);
}

let redis: Redis | null = null;
function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  if (!redis) redis = new Redis({ url, token });
  return redis;
}

function makeClient() {
  return createPublicClient({ chain: base, transport: http() });
}
let client: ReturnType<typeof makeClient> | null = null;
function getClient() {
  if (!client) client = makeClient();
  return client;
}

export async function hasSmartTokenAccess(wallet: string | null | undefined): Promise<boolean> {
  const min = gateMinWei();
  if (!min) return false;
  if (!wallet || !wallet.startsWith("0x")) return false;

  const cacheKey = `tokengate:${wallet.toLowerCase()}`;
  const store = getRedis();

  if (store) {
    try {
      const cached = await store.get<string>(cacheKey);
      if (cached === "1") return true;
      if (cached === "0") return false;
    } catch { /* cache miss path — fall through to RPC */ }
  }

  try {
    const balance = await getClient().readContract({
      address: SKOPOS_TOKEN,
      abi: BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [getAddress(wallet)],
    });
    const access = balance >= min;
    if (store) {
      try { await store.set(cacheKey, access ? "1" : "0", { ex: CACHE_TTL_SECONDS }); } catch { /* non-fatal */ }
    }
    return access;
  } catch (err) {
    console.error("[tokengate] balance read failed — denying holder access:", err instanceof Error ? err.message : err);
    return false;
  }
}
