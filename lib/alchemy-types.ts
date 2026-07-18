export interface TxData {
  hash: string;
  chainId: number;
  chainName: string;
  explorerUrl: string;
  from: string;
  to: string | null;
  valueEth: string;
  status: "success" | "failed" | "pending";
  blockNumber: number;
  gasUsed: string;
  gasCostEth: string;
  method: string | null;
  timestamp: number | null;
  logCount: number;
  // Present only for ERC-20 approve() calls — the spender granted an allowance,
  // and whether that allowance is effectively unlimited (the classic drainer vector).
  approval: { spender: string; unlimited: boolean } | null;
  // Blockscout PRO API's grounded summary (lib/blockscout.ts's
  // getBlockscoutTxSummary) — built from the actual decoded trace, not the
  // sparse-metadata guess lib/parseIntent.ts's generateTxSummary() makes.
  // null when BLOCKSCOUT_API_KEY is unset, the chain isn't PRO-covered, or the
  // call fails — never populated from a lower-confidence source instead.
  aiSummary?: string | null;
}

export interface Transfer {
  hash: string;
  from: string;
  to: string | null;
  value: string;
  asset: string;
  direction: "in" | "out";
  blockNum: string;
}

export interface ChainBalance {
  chainId: number;
  chainName: string;
  nativeSymbol: string;
  native: string;
  usdPrice?: number;
  usdValue?: number;
}

export interface TokenBalance {
  contractAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: string;
  chainId: number;
  chainName: string;
  usdPrice?: number;
  usdValue?: number;
  priceChange24h?: number;
}

// Blockscout PRO API's /reputation (score) + /metadata (public tags: "Scammer",
// "CEX Hot Wallet", etc.) merged — a bare score is uninterpretable alone.
export interface AddressReputation {
  score: number | null;
  tags: { name: string; slug: string; tagType: string }[];
}

export interface AddressData {
  address: string;
  balances: ChainBalance[];
  tokenBalances: TokenBalance[];
  recentTransfers: Transfer[];
  totalUsdValue?: number;
  // null when BLOCKSCOUT_API_KEY is unset or Blockscout has no data for this address.
  reputation?: AddressReputation | null;
}
