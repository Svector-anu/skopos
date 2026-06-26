import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import type { WalletClient } from "viem";

// User-signed x402 purchase for the Smart subscription. Mirrors smartMoneyClient:
// the wallet signs an EIP-3009 USDC authorization against the 402 requirements
// returned by /api/subscribe; no private key leaves the wallet. COMPILE-VERIFIED
// ONLY — live settlement on Base needs a funded wallet + a mainnet facilitator.

const BASE_NETWORK = "eip155:8453";

export interface SubscribeResult {
  ok: boolean;
  expiry?: number;
  transaction?: string;
  error?: string;
}

function walletToSigner(walletClient: WalletClient) {
  const account = walletClient.account;
  if (!account) throw new Error("Connect a wallet to subscribe.");
  return toClientEvmSigner({
    address: account.address,
    signTypedData: (message) =>
      walletClient.signTypedData({
        account,
        domain: message.domain,
        types: message.types,
        primaryType: message.primaryType,
        message: message.message,
      } as Parameters<WalletClient["signTypedData"]>[0]),
  });
}

export async function subscribe(walletClient: WalletClient): Promise<SubscribeResult> {
  const client = new x402Client().register(BASE_NETWORK, new ExactEvmScheme(walletToSigner(walletClient)));
  const payFetch = wrapFetchWithPayment(globalThis.fetch, client);

  const res = await payFetch("/api/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });

  if (!res.ok) {
    let error = `Subscription failed (${res.status}).`;
    try {
      const body = await res.json();
      if (body?.error) error = String(body.error);
    } catch {
      // non-JSON error body — keep the status-based message
    }
    return { ok: false, error };
  }

  const data = await res.json();
  return { ok: true, expiry: data.expiry, transaction: data.transaction };
}
