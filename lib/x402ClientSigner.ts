import { toClientEvmSigner } from "@x402/evm";
import type { WalletClient } from "viem";

// Adapt a user's connected wagmi/Privy WalletClient into an x402 ClientEvmSigner
// — the wallet signs the EIP-3009 typed data client-side, no private key ever
// leaves it. Three call sites (lib/smartMoneyClient.ts, lib/subscribeClient.ts,
// lib/x402GenericClient.ts) each reimplemented this identically, differing only
// in the error message shown when no wallet is connected — one copy, parameterized.
export function walletToSigner(walletClient: WalletClient, connectMessage: string) {
  const account = walletClient.account;
  if (!account) throw new Error(connectMessage);
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
