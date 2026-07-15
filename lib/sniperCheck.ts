import { getAgentPayFetch } from "./x402Agent";

// Base sniper detection via x402 Chain Intel (x402-chain-intel.vercel.app) —
// Skopos's own Base wallet fronts the $0.18 USDC micropayment, same
// non-custodial pattern as lib/smartMoneyServer.ts's Nansen reads.
//
// Replaces HYRE Agent for Base as of 2026-07-15 — HYRE's Base endpoint
// negotiates payment fine (lib/x402Agent.ts's v1 registration) but 500s on
// every well-formed payment before settlement (confirmed no charge, confirmed
// reproducible). Chain Intel's challenge is a clean, spec-conformant x402 v2
// response — no client-side fix needed. Live-verified against AERO
// (0x940181a94a35a4569e4529a3cdfb74e38fd98631): 4 early buyers, all sharing
// one txHash — a textbook confirmed bundle.
//
// Solana and RH Chain (SKALE) remain blocked, unrelated to this swap:
//   - Solana: lib/x402Agent.ts has no Solana keypair, no signer at all.
//   - RH Chain: HYRE's SKALE challenge declares x402Version 2 but keeps v1
//     field names (maxAmountRequired) and omits the v2-required top-level
//     `resource` object — fails schema validation before any payment is
//     attempted. Not fixable client-side; re-test if HYRE corrects the shape.
// See docs/paid-data-sources.md for the full writeup.
const CHAIN_INTEL_URL = "https://x402-chain-intel.vercel.app/api/hunter/early-buyers";
const SETTLEMENT_TIMEOUT_MS = 60_000;
const CONFIRMED_BUNDLE_MIN_BUYERS = 3;

const SNIPER_SUPPORTED_CHAINS = ["base"];

export const SNIPER_CHECK_SUPPORTED_CHAINS = SNIPER_SUPPORTED_CHAINS;

export interface EarlyBuyer {
  address: string;
  txHash: string;
  value: number;
}

export interface SniperCheck {
  earlyBuyerCount: number;
  confirmedBundle: boolean;
  buyers: EarlyBuyer[];
}

export function sniperCheckSupportsChain(chainId: string): boolean {
  return SNIPER_SUPPORTED_CHAINS.includes(chainId.toLowerCase().trim());
}

export async function getSniperCheck(chainId: string, tokenAddress: string): Promise<SniperCheck | null> {
  const chain = chainId.toLowerCase().trim();
  if (!sniperCheckSupportsChain(chain)) return null;

  const payFetch = getAgentPayFetch();
  if (!payFetch) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SETTLEMENT_TIMEOUT_MS);
  try {
    const res = await payFetch(CHAIN_INTEL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: tokenAddress.trim(), chain }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[chain-intel-paid] early-buyers ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (typeof data?.earlyBuyerCount !== "number" || !Array.isArray(data?.earlyBuyers)) {
      console.error("[chain-intel-paid] early-buyers returned an unexpected shape");
      return null;
    }
    const buyers: EarlyBuyer[] = data.earlyBuyers
      .filter((b: unknown): b is Record<string, unknown> => typeof b === "object" && b !== null)
      .map((b: Record<string, unknown>) => ({
        address: typeof b.address === "string" ? b.address : "",
        txHash: typeof b.txHash === "string" ? b.txHash : "",
        value: typeof b.value === "number" ? b.value : 0,
      }));
    const confirmedBundle =
      data.earlyBuyerCount >= CONFIRMED_BUNDLE_MIN_BUYERS &&
      buyers.length > 0 &&
      buyers.every((b) => b.txHash === buyers[0].txHash);
    return { earlyBuyerCount: data.earlyBuyerCount, confirmedBundle, buyers };
  } catch (err) {
    console.error("[chain-intel-paid] early-buyers threw:", err instanceof Error ? `${err.name}: ${err.message}` : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
