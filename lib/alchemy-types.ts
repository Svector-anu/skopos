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
}

export interface TokenBalance {
  contractAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: string;    // human-readable
  chainId: number;
  chainName: string;
}

export interface AddressData {
  address: string;
  balances: ChainBalance[];
  tokenBalances: TokenBalance[];
  recentTransfers: Transfer[];
}
