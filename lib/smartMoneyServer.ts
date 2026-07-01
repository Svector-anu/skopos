import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

// Server-signed x402 settlement. Skopos's own Base wallet fronts the ~$0.01 USDC
// micropayment for the Nansen smart-money read, so the browser needs no wallet,
// no chain switch, and no signature — the user just asks and gets the answer.
// Gated on SKOPOS_X402_PRIVATE_KEY; unset falls back to the user-signed path in
// lib/smartMoneyClient.ts. The wallet pays in USDC only (EIP-3009 is gasless for
// the payer — the facilitator submits), so it needs USDC on Base, no ETH.

const BASE_NETWORK = "eip155:8453";
const NANSEN_RESOURCE = "https://api.nansen.ai/api/v1/tgm/who-bought-sold";
const LOOKBACK_DAYS = 30;
const SETTLEMENT_TIMEOUT_MS = 60_000;

export interface SmartMoneyResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

function agentKey(): `0x${string}` | null {
  const raw = process.env.SKOPOS_X402_PRIVATE_KEY?.trim();
  if (!raw) return null;
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  return /^0x[0-9a-fA-F]{64}$/.test(key) ? (key as `0x${string}`) : null;
}

export function agentPaidEnabled(): boolean {
  return agentKey() !== null;
}

function isoNoMillis(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function fetchSmartMoneyServer(
  token: { symbol: string | null; address: string | null; chain?: string | null },
  direction: "BUY" | "SELL" = "BUY",
): Promise<SmartMoneyResponse> {
  const key = agentKey();
  if (!key) return { ok: false, error: "Agent payments are not configured." };
  if (!token.address || !token.chain) {
    return { ok: false, error: "Couldn't locate this token on a supported chain." };
  }

  const account = privateKeyToAccount(key);
  const signer = toClientEvmSigner({
    address: account.address,
    signTypedData: (message) =>
      account.signTypedData({
        domain: message.domain,
        types: message.types,
        primaryType: message.primaryType,
        message: message.message,
      } as Parameters<typeof account.signTypedData>[0]),
  });

  const client = new x402Client().register(BASE_NETWORK, new ExactEvmScheme(signer));
  const payFetch = wrapFetchWithPayment(globalThis.fetch, client);

  const now = new Date();
  const from = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SETTLEMENT_TIMEOUT_MS);
  try {
    const res = await payFetch(NANSEN_RESOURCE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chain: token.chain,
        token_address: token.address,
        buy_or_sell: direction,
        date: { from: isoNoMillis(from), to: isoNoMillis(now) },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[smart-money-server] Nansen ${res.status}`);
      return { ok: false, error: `Smart-money request failed (${res.status}).` };
    }
    return { ok: true, data: await res.json() };
  } catch (err) {
    console.error(
      "[smart-money-server] paid fetch threw:",
      err instanceof Error ? `${err.name}: ${err.message}` : err,
    );
    return { ok: false, error: "Smart-money read failed to settle." };
  } finally {
    clearTimeout(timer);
  }
}
