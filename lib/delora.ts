const BASE       = "https://api.delora.build";
const API_KEY    = process.env.DELORA_API_KEY ?? "";
const INTEGRATOR = process.env.DELORA_INTEGRATOR ?? "ANU";
const FEE        = 0.0005; // 0.05% integrator fee



const TIMEOUT_MS = 8000;

async function fetchWithTimeout(input: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers = new Headers(init?.headers);
  if (API_KEY) headers.set("x-api-key", API_KEY);
  try {
    return await fetch(input, { ...init, headers, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// ── Chain types ───────────────────────────────────────────────────────────────

export interface DeloraChain {
  id: number;
  key: string;
  name: string;
  chainType: "EVM" | "SVM";
  nativeToken: {
    address: string;
    symbol: string;
    decimals: number;
  };
  DeloraDiamond?: string;
  blockExplorerUrls?: string;
}

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
let chainsCache: DeloraChain[] | null = null;
let chainsCacheTime = 0;
let tokensCache: Record<string, DeloraToken[]> | null = null;
let tokensCacheTime = 0;

export async function getChains(): Promise<DeloraChain[]> {
  if (chainsCache && Date.now() - chainsCacheTime < CACHE_TTL_MS) return chainsCache;
  const res = await fetchWithTimeout(`${BASE}/v1/chains`);
  if (!res.ok) return chainsCache ?? [];
  const data = await res.json();
  chainsCache = (data.chains ?? data) as DeloraChain[];
  chainsCacheTime = Date.now();
  return chainsCache;
}

export async function getChainById(chainId: number): Promise<DeloraChain | null> {
  const chains = await getChains();
  return chains.find(c => c.id === chainId) ?? null;
}



// ── Token types ───────────────────────────────────────────────────────────────

export interface DeloraToken {
  address: string;
  symbol: string;
  decimals: number;
  chainId: number;
  name: string;
}

export interface DeloraQuote {
  inputAmount?: string;
  outputAmount?: string;
  adapter?: string;
  calldata?: {
    to: string;
    value: string;
    data: string;
  };
  fees?: {
    total?: {
      amount: string;
      currencySymbol: string;
      decimals: number;
      amountUsd?: string;
    };
    breakdown?: {
      type: string;
      amount: string;
      amountUsd: string;
    }[];
    totalUsd?: string;
  };
  gas?: {
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
  };
  [key: string]: unknown;
}

export async function getToken(
  chainId: number,
  symbol: string
): Promise<DeloraToken | null> {
  if (!tokensCache || Date.now() - tokensCacheTime >= CACHE_TTL_MS) {
    const res = await fetchWithTimeout(`${BASE}/v1/tokens`);
    if (res.ok) {
      tokensCache = await res.json() as Record<string, DeloraToken[]>;
      tokensCacheTime = Date.now();
    } else if (!tokensCache) {
      return null;
    }
  }
  const chainTokens = tokensCache[String(chainId)];
  if (!Array.isArray(chainTokens)) return null;
  const upper = symbol.toUpperCase();
  // Exact match first
  const exact = chainTokens.find(t => t.symbol.toUpperCase() === upper);
  if (exact) return exact;
  // Chain-suffixed variants: "USDC-BNB", "USDC.e", "USDC.BASE", etc.
  return chainTokens.find(t => {
    const s = t.symbol.toUpperCase();
    return s.startsWith(upper + "-") || s.startsWith(upper + ".");
  }) ?? null;
}

export async function getQuote(params: {
  originChainId: number;
  destinationChainId: number;
  amount: string;
  originCurrency: string;
  destinationCurrency: string;
  senderAddress?: string;
  receiverAddress?: string;
  slippage?: number;
}): Promise<DeloraQuote> {
 if (!params.senderAddress || !params.receiverAddress) {
  throw new Error("senderAddress and receiverAddress are required for Delora quotes.");
}

const query = new URLSearchParams({
  originChainId: String(params.originChainId),
  destinationChainId: String(params.destinationChainId),
  amount: params.amount,
  originCurrency: params.originCurrency,
  destinationCurrency: params.destinationCurrency,
  senderAddress: params.senderAddress,
  receiverAddress: params.receiverAddress,
});
  if (params.slippage != null) query.set("slippage", String(params.slippage));
  query.set("integrator", INTEGRATOR);
  query.set("fee", String(FEE));

  const res = await fetchWithTimeout(`${BASE}/v1/quotes?${query}`);
  if (!res.ok) {
    if (res.status === 429) throw new Error("Rate limit reached — please wait a moment and try again.");
    // Read body for server-side logging only — never forward raw upstream errors to clients
    const text = await res.text();
    console.error(`[delora] quote error ${res.status}:`, text.slice(0, 500));
    throw new Error(`Could not get a quote (status ${res.status}).`);
  }
  return res.json();
}
