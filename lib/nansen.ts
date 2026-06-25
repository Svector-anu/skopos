const BASE       = "https://api.nansen.ai";
const TIMEOUT_MS = 8000;
const BASE_CHAIN  = "eip155:8453";
const USDC_BASE   = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase();

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
    resourceUrl: payload.resource?.url ?? `${BASE}/api/v1/smart-money/holdings`,
  };
}

export async function getSmartMoneyQuote(): Promise<SmartMoneyQuote | null> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${BASE}/api/v1/smart-money/holdings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chains: ["ethereum", "base"] }),
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
