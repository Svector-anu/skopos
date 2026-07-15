import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { ExactEvmSchemeV1 } from "@x402/evm/v1";
import { privateKeyToAccount } from "viem/accounts";

// Shared x402 payment client for Skopos's OWN agent wallet (SKOPOS_X402_PRIVATE_KEY)
// — every place Skopos itself pays an external x402 endpoint (Nansen TGM reads,
// docs/paid-data-sources.md) reuses this one signer setup instead of each caller
// re-deriving its own account/signer/client. The wallet pays in USDC only
// (EIP-3009 is gasless for the payer — the facilitator submits), so it needs USDC
// on Base, no ETH.
//
// Registers BOTH x402 v2 (CAIP-2 "eip155:8453") and legacy v1 (bare "base")
// scheme clients — some real sellers (e.g. HYRE Agent's Base sniper endpoint,
// confirmed live 2026-07-15) still issue v1-shaped 402 challenges. Without the
// v1 registration, x402Client.createPaymentPayload() throws "No client
// registered for x402 version: 1" *before* any payment is attempted — callers
// see it as a normal failure and (correctly) fail closed to null, but the
// paid data silently never arrives. See lib/sniperCheck.ts.

const BASE_NETWORK = "eip155:8453";
const BASE_NETWORK_V1 = "base";

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
  const client = new x402Client()
    .register(BASE_NETWORK, new ExactEvmScheme(signer))
    .registerV1(BASE_NETWORK_V1, new ExactEvmSchemeV1(signer));
  cached = wrapFetchWithPayment(globalThis.fetch, client);
  return cached;
}
