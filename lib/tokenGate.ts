import { createPublicClient, http, getAddress } from "viem";
import { base } from "viem/chains";
import { getRedis } from "./redis";

// $skopos holder tiers for the Smart tier. Holding more $skopos lifts a wallet's
// daily Smart cap through ascending bands — bounded upgrades, not the uncapped
// bypass paid subs get. Gives the token real, accumulating utility (hold more →
// more Smart), which is the demand side of the fee→compute flywheel.
//
// Tiers are env-configured. Tier 1 reuses the original gate vars; tiers 2-3 are
// optional higher bands. A wallet gets the cap of the HIGHEST band its balance
// meets. Disabled by default: SMART_TOKEN_GATE_MIN unset → no band is active →
// resolveHolderCap() always returns null and everyone uses the free cap.
//
// Fails to "no holder cap" on any RPC or Redis error: a holder simply falls back
// to the free cap rather than the request breaking. Never grants on failure.

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

type Tier = { min: bigint; cap: number };

const TIER_BANDS: Array<{ minVar: string; capVar: string; defaultCap: number }> = [
  { minVar: "SMART_TOKEN_GATE_MIN",    capVar: "SMART_HOLDER_DAILY_CAP", defaultCap: 100 },
  { minVar: "SMART_TOKEN_GATE_T2_MIN", capVar: "SMART_HOLDER_T2_CAP",    defaultCap: 250 },
  { minVar: "SMART_TOKEN_GATE_T3_MIN", capVar: "SMART_HOLDER_T3_CAP",    defaultCap: 1000 },
];

function envNum(name: string): number | null {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function toWei(wholeTokens: number): bigint {
  return BigInt(Math.floor(wholeTokens)) * BigInt(10) ** BigInt(TOKEN_DECIMALS);
}

// Active bands, ascending by min. An unset min disables that band.
function tiers(): Tier[] {
  const out: Tier[] = [];
  for (const band of TIER_BANDS) {
    const min = envNum(band.minVar);
    if (min === null) continue;
    out.push({ min: toWei(min), cap: envNum(band.capVar) ?? band.defaultCap });
  }
  return out.sort((a, b) => (a.min < b.min ? -1 : a.min > b.min ? 1 : 0));
}

function makeClient() {
  return createPublicClient({ chain: base, transport: http() });
}
let client: ReturnType<typeof makeClient> | null = null;
function getClient() {
  if (!client) client = makeClient();
  return client;
}

// Returns the wallet's holder daily-cap, or null when the gate is disabled, the
// wallet holds below tier 1, or the lookup fails. The caller treats null as
// "use the free cap".
export async function resolveHolderCap(wallet: string | null | undefined): Promise<number | null> {
  const bands = tiers();
  if (bands.length === 0) return null;
  if (!wallet || !wallet.startsWith("0x")) return null;

  const cacheKey = `tokengate:${wallet.toLowerCase()}`;
  const store = getRedis();

  if (store) {
    try {
      const cached = await store.get<string>(cacheKey);
      if (cached !== null && cached !== undefined) {
        const n = Number(cached);
        return n > 0 ? n : null;
      }
    } catch { /* cache miss path — fall through to RPC */ }
  }

  try {
    const balance = await getClient().readContract({
      address: SKOPOS_TOKEN,
      abi: BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [getAddress(wallet)],
    });
    let cap = 0;
    for (const tier of bands) {
      if (balance >= tier.min) cap = tier.cap;
    }
    if (store) {
      try { await store.set(cacheKey, String(cap), { ex: CACHE_TTL_SECONDS }); } catch { /* non-fatal */ }
    }
    return cap > 0 ? cap : null;
  } catch (err) {
    console.error("[tokengate] balance read failed — denying holder cap:", err instanceof Error ? err.message : err);
    return null;
  }
}
