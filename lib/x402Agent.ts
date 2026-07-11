import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

// Shared x402 payment client for Skopos's OWN agent wallet (SKOPOS_X402_PRIVATE_KEY)
// — every place Skopos itself pays an external x402 endpoint (Nansen TGM reads,
// docs/paid-data-sources.md) reuses this one signer setup instead of each caller
// re-deriving its own account/signer/client. The wallet pays in USDC only
// (EIP-3009 is gasless for the payer — the facilitator submits), so it needs USDC
// on Base, no ETH.

const BASE_NETWORK = "eip155:8453";

function agentKey(): `0x${string}` | null {
  const raw = process.env.SKOPOS_X402_PRIVATE_KEY?.trim();
  if (!raw) return null;
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  return /^0x[0-9a-fA-F]{64}$/.test(key) ? (key as `0x${string}`) : null;
}

export function agentPaidEnabled(): boolean {
  return agentKey() !== null;
}

let cached: typeof fetch | null = null;

// Returns a fetch() that transparently pays any x402 402 challenge from Skopos's
// agent wallet, or null if SKOPOS_X402_PRIVATE_KEY isn't configured. Cached — the
// signer/client only need to be built once per process.
export function getAgentPayFetch(): typeof fetch | null {
  if (cached) return cached;
  const key = agentKey();
  if (!key) return null;
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
  cached = wrapFetchWithPayment(globalThis.fetch, client);
  return cached;
}
