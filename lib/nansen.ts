const BASE       = "https://api.nansen.ai";
const TIMEOUT_MS = 8000;
const BASE_CHAIN  = "eip155:8453";
const USDC_BASE   = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase();
const SMART_MONEY_RESOURCE = `${BASE}/api/v1/tgm/who-bought-sold`;

// DexScreener chain slug → Nansen chain slug. Kept deliberately to chains whose
// Nansen slug is confirmed, because Token God Mode validates the chain only AFTER
// the x402 payment settles — an unknown slug means the user pays and then gets a
// 422. Extend only with chains verified against a live paid call.
const NANSEN_CHAIN_BY_DEX: Record<string, string> = {
  ethereum: "ethereum",
  base:     "base",
  solana:   "solana",
  arbitrum: "arbitrum",
  polygon:  "polygon",
};

export function toNansenChain(dexChainId: string): string | null {
  return NANSEN_CHAIN_BY_DEX[dexChainId.toLowerCase()] ?? null;
}

async function fetchWithTimeout(input: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

interface X402Accept {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  extra?: { name?: string; version?: string };
}

export interface SmartMoneyQuote {
  network: string;
  asset: string;
  amountAtomic: string;
  amountUsd: number;
  payTo: string;
  resourceUrl: string;
}

function decodeBaseUsdcAccept(payload: { accepts?: X402Accept[]; resource?: { url?: string } }): SmartMoneyQuote | null {
  const accept = payload.accepts?.find(
    a => a.network === BASE_CHAIN && a.asset?.toLowerCase() === USDC_BASE,
  );
  if (!accept) return null;
  return {
    network: accept.network,
    asset: accept.asset,
    amountAtomic: accept.amount,
    amountUsd: Number(accept.amount) / 1e6,
    payTo: accept.payTo,
    resourceUrl: payload.resource?.url ?? SMART_MONEY_RESOURCE,
  };
}

export async function getSmartMoneyQuote(): Promise<SmartMoneyQuote | null> {
  let res: Response;
  try {
    res = await fetchWithTimeout(SMART_MONEY_RESOURCE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  } catch {
    return null;
  }

  if (res.status !== 402) {
    console.error(`[nansen] expected 402 quote, got ${res.status}`);
    return null;
  }

  const header = res.headers.get("payment-required");
  try {
    if (header) {
      const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
      const quote = decodeBaseUsdcAccept(decoded);
      if (quote) return quote;
    }
    const body = await res.json();
    return decodeBaseUsdcAccept(body);
  } catch (err) {
    console.error("[nansen] failed to decode payment challenge:", err);
    return null;
  }
}
