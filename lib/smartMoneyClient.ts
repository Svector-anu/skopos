import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import type { WalletClient } from "viem";

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

// Adapt the user's wagmi/Privy wallet into an x402 ClientEvmSigner. The wallet
// signs the EIP-3009 typed data; no private key ever leaves the wallet.
function walletToSigner(walletClient: WalletClient) {
  const account = walletClient.account;
  if (!account) throw new Error("Connect a wallet to pay for the smart-money read.");
  return toClientEvmSigner({
    address: account.address,
    signTypedData: (message) =>
      walletClient.signTypedData({
        account,
        // x402 passes loose Record types; viem wants its TypedData generics.
        domain: message.domain,
        types: message.types,
        primaryType: message.primaryType,
        message: message.message,
      } as Parameters<WalletClient["signTypedData"]>[0]),
  });
}

export async function fetchSmartMoney(
  walletClient: WalletClient,
  token: { symbol: string | null; address: string | null },
): Promise<SmartMoneyResponse> {
  const client = new x402Client().register(BASE_NETWORK, new ExactEvmScheme(walletToSigner(walletClient)));
  const payFetch = wrapFetchWithPayment(globalThis.fetch, client);

  // Routed through the same-origin proxy (avoids CORS; proxy relays to Nansen).
  // TODO(live): confirm the smart-money endpoint + filter shape that scopes the
  // result to `token` — holdings is a starting point pending live verification.
  const res = await payFetch("/api/intel/nansen", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint: "holdings",
      body: { chains: ["ethereum", "base"], token },
    }),
  });

  if (!res.ok) {
    return { ok: false, error: `Smart-money request failed (${res.status}).` };
  }
  return { ok: true, data: await res.json() };
}
