import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import type { WalletClient } from "viem";
import { walletToSigner } from "./x402ClientSigner";

// NOTE: This module is the user-signed x402 settlement path and is COMPILE-VERIFIED
// ONLY. The live $0.05 USDC payment + Nansen settlement cannot be exercised without
// a connected, funded wallet in the browser. Expect the signer adapter and the
// request body/endpoint shape to need tuning on first real run.

const BASE_NETWORK = "eip155:8453";

export interface SmartMoneyResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

const LOOKBACK_DAYS = 30;

function isoNoMillis(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function fetchSmartMoney(
  walletClient: WalletClient,
  token: { symbol: string | null; address: string | null; chain?: string | null },
  direction: "BUY" | "SELL" = "BUY",
): Promise<SmartMoneyResponse> {
  if (!token.address || !token.chain) {
    return { ok: false, error: "Couldn't locate this token on a supported chain." };
  }

  const client = new x402Client().register(BASE_NETWORK, new ExactEvmScheme(walletToSigner(walletClient, "Connect a wallet to pay for the smart-money read.")));
  const payFetch = wrapFetchWithPayment(globalThis.fetch, client);

  const now = new Date();
  const from = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);

  // Token God Mode "who-bought-sold" scoped to this token + chain. No
  // include_smart_money_labels filter: Nansen's entity labels are Pro-gated and
  // unavailable over keyless x402 (their /labels/* data), so filtering by them
  // returns an empty set. Without it the endpoint returns the token's top
  // wallets by trade volume — which IS available at the $0.01 tier. Routed
  // through the same-origin proxy; the user's wallet signs the x402 payment.
  const res = await payFetch("/api/intel/nansen", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint: "tgm/who-bought-sold",
      body: {
        chain: token.chain,
        token_address: token.address,
        buy_or_sell: direction,
        date: { from: isoNoMillis(from), to: isoNoMillis(now) },
      },
    }),
  });

  if (!res.ok) {
    return { ok: false, error: `Smart-money request failed (${res.status}).` };
  }
  return { ok: true, data: await res.json() };
}
