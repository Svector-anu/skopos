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

export interface AddressData {
  address: string;
  balances: ChainBalance[];
  tokenBalances: TokenBalance[];
  recentTransfers: Transfer[];
  totalUsdValue?: number;
}
