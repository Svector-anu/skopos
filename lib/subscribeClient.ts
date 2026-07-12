import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import type { WalletClient } from "viem";
import { walletToSigner } from "./x402ClientSigner";

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

export async function subscribe(walletClient: WalletClient): Promise<SubscribeResult> {
  if (!SUBSCRIBE_URL) return { ok: false, error: "Subscriptions are not enabled yet." };
  const account = walletClient.account;
  if (!account) return { ok: false, error: "Connect a wallet to subscribe." };

  const client = new x402Client().register(NETWORK, new ExactEvmScheme(walletToSigner(walletClient, "Connect a wallet to subscribe.")));
  const payFetch = wrapFetchWithPayment(globalThis.fetch, client);

  let res: Response;
  try {
    res = await payFetch(SUBSCRIBE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: account.address }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (/reject|denied|cancel|\b4001\b/i.test(msg)) {
      return { ok: false, error: "Payment cancelled — you weren't charged." };
    }
    return { ok: false, error: "Could not complete payment. Please try again." };
  }

  // A 402 here means the payment was never attached (the user declined the
  // signature), so the endpoint is still asking for payment — not a failure to
  // surface as a raw error.
  if (res.status === 402) {
    return { ok: false, error: "Payment cancelled — you weren't charged." };
  }

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
