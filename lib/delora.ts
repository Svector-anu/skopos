const BASE = "https://api.delora.build";

export interface DeloraToken {
  address: string;
  symbol: string;
  decimals: number;
  chainId: number;
  name: string;
}

export interface DeloraQuote {
  outputAmount?: string;
  destinationAmount?: string;
  toAmount?: string;
  transactionRequest?: {
    to: string;
    value: string;
    data: string;
    from?: string;
    gasLimit?: string;
  };
  transaction?: {
    to: string;
    value: string;
    data: string;
  };
  tool?: string;
  toolDetails?: { name: string; logoURI?: string };
  feeCosts?: { name: string; amount: string; amountUSD: string }[];
  gasCosts?: { amount: string; amountUSD: string }[];
  estimate?: {
    toAmount: string;
    fromAmount: string;
    feeCosts: { name: string; amount: string; amountUSD: string }[];
    gasCosts: { amount: string; amountUSD: string }[];
  };
  [key: string]: unknown;
}

export async function getToken(
  chainId: number,
  symbol: string
): Promise<DeloraToken | null> {
  const res = await fetch(
    `${BASE}/v1/tokens?chainId=${chainId}&symbol=${encodeURIComponent(symbol)}`
  );
  if (!res.ok) return null;
  const data = await res.json();
  const token = Array.isArray(data) ? data[0] : (data?.tokens?.[0] ?? data);
  return token ?? null;
}

export async function getQuote(params: {
  originChainId: number;
  destinationChainId: number;
  amount: string;
  originCurrency: string;
  destinationCurrency: string;
  senderAddress?: string;
}): Promise<DeloraQuote> {
  const query = new URLSearchParams({
    originChainId: String(params.originChainId),
    destinationChainId: String(params.destinationChainId),
    amount: params.amount,
    originCurrency: params.originCurrency,
    destinationCurrency: params.destinationCurrency,
    ...(params.senderAddress ? { senderAddress: params.senderAddress } : {}),
  });

  const res = await fetch(`${BASE}/v1/quotes?${query}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Delora quote failed ${res.status}: ${text}`);
  }
  return res.json();
}
