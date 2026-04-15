const BASE = "https://api.delora.build";

const PLACEHOLDER_ADDRESS = "0x0000000000000000000000000000000000000001";

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
  const res = await fetch(`${BASE}/v1/tokens`);
  if (!res.ok) return null;
  const data: Record<string, DeloraToken[]> = await res.json();
  const chainTokens = data[String(chainId)];
  if (!Array.isArray(chainTokens)) return null;
  return (
    chainTokens.find(
      (t) => t.symbol.toUpperCase() === symbol.toUpperCase()
    ) ?? null
  );
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
  const query = new URLSearchParams({
    originChainId: String(params.originChainId),
    destinationChainId: String(params.destinationChainId),
    amount: params.amount,
    originCurrency: params.originCurrency,
    destinationCurrency: params.destinationCurrency,
    senderAddress: params.senderAddress ?? PLACEHOLDER_ADDRESS,
    receiverAddress: params.receiverAddress ?? PLACEHOLDER_ADDRESS,
  });
  if (params.slippage != null) query.set("slippage", String(params.slippage));

  const res = await fetch(`${BASE}/v1/quotes?${query}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Delora quote failed ${res.status}: ${text}`);
  }
  return res.json();
}
