import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import type { WalletClient } from "viem";
import { walletToSigner } from "./x402ClientSigner";

// Pays and calls ANY x402 endpoint using the user's OWN connected wallet — no
// endpoint-specific knowledge required, unlike every hardcoded source in
// docs/paid-data-sources.md (all of which Skopos's own wallet pays for). This is
// the deliberately different, generic path: the user names an endpoint, sees its
// price via lib/x402Discover.ts's free probe, and pays for it themselves if they
// want to proceed. Skopos's agent wallet never touches this flow.
//
// NOTE: compile-verified only, same caveat as lib/smartMoneyClient.ts — the
// signer adapter and response handling haven't been exercised against a real
// connected wallet + real arbitrary endpoint yet. Expect tuning on first real use.

const BASE_NETWORK = "eip155:8453";

export interface X402GenericResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export async function callX402Endpoint(
  walletClient: WalletClient,
  url: string,
  method: "GET" | "POST" = "GET",
  body?: Record<string, unknown> | null,
): Promise<X402GenericResponse> {
  const client = new x402Client().register(BASE_NETWORK, new ExactEvmScheme(walletToSigner(walletClient, "Connect a wallet to pay for this.")));
  const payFetch = wrapFetchWithPayment(globalThis.fetch, client);
  try {
    const res = await payFetch(url, {
      method,
      headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
      body: method === "POST" && body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) return { ok: false, error: `Request failed (${res.status}).` };
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Payment failed." };
  }
}
