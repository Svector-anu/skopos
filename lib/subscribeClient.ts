import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import type { WalletClient } from "viem";

// User-signed x402 purchase for the Smart subscription. The wallet signs an
// EIP-3009 USDC authorization against the 402 returned by the Bankr x402 Cloud
// endpoint (x402.bankr.bot/<wallet>/skopos-subscribe); Bankr verifies + settles
// on Base mainnet and our handler grants the sub. We send the connected wallet so
// the handler knows which address to credit. COMPILE-VERIFIED ONLY — live
// settlement needs a funded wallet on Base.

const NETWORK = "eip155:8453";
const SUBSCRIBE_URL = process.env.NEXT_PUBLIC_SUBSCRIBE_URL;

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
  if (!SUBSCRIBE_URL) return { ok: false, error: "Subscriptions are not enabled yet." };
  const account = walletClient.account;
  if (!account) return { ok: false, error: "Connect a wallet to subscribe." };

  const client = new x402Client().register(NETWORK, new ExactEvmScheme(walletToSigner(walletClient)));
  const payFetch = wrapFetchWithPayment(globalThis.fetch, client);

  const res = await payFetch(SUBSCRIBE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: account.address }),
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
