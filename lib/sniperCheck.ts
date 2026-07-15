import { getAgentPayFetch } from "./x402Agent";

// Sniper detection via HYRE Agent (mpp.hyreagent.fun) — Skopos's own Base wallet
// fronts the $0.04 USDC micropayment, same non-custodial pattern as
// lib/smartMoneyServer.ts's Nansen reads.
//
// HYRE covers Solana (root paths), Base (/base/*), and SKALE (/skale/*), but
// lib/x402Agent.ts's signer only registers the Base network (eip155:8453) — no
// Solana keypair, no SKALE registration. Live-testing the SKALE endpoint with
// CASHCAT (0x020bfc650a365f8bb26819deaabf3e21291018b4) confirmed it's a real,
// live 402 challenge, but attempting payment fails with a payment-required parse
// error — the challenge itself doesn't conform to a parseable x402 response.
// Both Solana and SKALE are deferred until there's a signer for them (Solana)
// and the SKALE 402 challenge is fixed upstream or worked around.
const HYRE_BASE = "https://mpp.hyreagent.fun";
const SETTLEMENT_TIMEOUT_MS = 60_000;

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
