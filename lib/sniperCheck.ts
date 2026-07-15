import { getAgentPayFetch } from "./x402Agent";

// Sniper detection via HYRE Agent (mpp.hyreagent.fun) — Skopos's own Base wallet
// fronts the $0.04 USDC micropayment, same non-custodial pattern as
// lib/smartMoneyServer.ts's Nansen reads.
//
// HYRE covers Solana (root paths), Base (/base/*), and SKALE (/skale/*). Status
// as of 2026-07-15, all three blocked, for three different reasons:
//   - Solana: lib/x402Agent.ts has no Solana keypair, no signer at all.
//   - Base: payment negotiation works (lib/x402Agent.ts registers the v1 scheme
//     HYRE's Base endpoint needs), but HYRE's server 500s on every well-formed
//     payment before settlement — confirmed no charge, confirmed reproducible.
//     Short-circuited below (HYRE_BASE_KNOWN_BROKEN) until HYRE fixes it.
//   - SKALE: re-tested live against CASHCAT (0x020bfc650a365f8bb26819deaabf3e
//     21291018b4) with the same v1-fixed client that unblocked Base — still
//     fails, but a different bug: the challenge declares x402Version 2 while
//     keeping v1-style field names (maxAmountRequired) and omitting the
//     v2-required top-level `resource` object, so it fails schema validation
//     ("Failed to parse payment requirements: Invalid payment required
//     response") before any payment is attempted. Not fixable client-side —
//     needs HYRE to correct their SKALE response shape.
// See docs/paid-data-sources.md's HYRE Agent section for the full writeup.
const HYRE_BASE = "https://mpp.hyreagent.fun";
const SETTLEMENT_TIMEOUT_MS = 60_000;
const HYRE_BASE_KNOWN_BROKEN = true;

const SNIPER_CHAIN_PATH: Record<string, string> = {
  base: "/base/trenches/token",
};

export const SNIPER_CHECK_SUPPORTED_CHAINS = Object.keys(SNIPER_CHAIN_PATH);

export interface SniperCheck {
  signal: "snipe" | "watch" | "avoid" | string;
  confidence: number;
  insight: string;
}

export function sniperCheckSupportsChain(chainId: string): boolean {
  return chainId.toLowerCase().trim() in SNIPER_CHAIN_PATH;
}

export async function getSniperCheck(chainId: string, tokenAddress: string): Promise<SniperCheck | null> {
  const prefix = SNIPER_CHAIN_PATH[chainId.toLowerCase().trim()];
  if (!prefix) return null;

  // Skip the guaranteed-dead round trip — see the header comment. Delete this
  // line once HYRE's Base endpoint is confirmed fixed.
  if (HYRE_BASE_KNOWN_BROKEN) return null;

  const payFetch = getAgentPayFetch();
  if (!payFetch) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SETTLEMENT_TIMEOUT_MS);
  try {
    const res = await payFetch(`${HYRE_BASE}${prefix}/${tokenAddress.trim()}/snipers`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[hyre-paid] snipers ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (typeof data?.signal !== "string" || typeof data?.confidence !== "number") {
      console.error("[hyre-paid] snipers returned an unexpected shape");
      return null;
    }
    return {
      signal: data.signal,
      confidence: data.confidence,
      insight: typeof data.insight === "string" ? data.insight : "",
    };
  } catch (err) {
    console.error("[hyre-paid] snipers threw:", err instanceof Error ? `${err.name}: ${err.message}` : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
