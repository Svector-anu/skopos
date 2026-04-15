export const CHAIN_IDS: Record<string, number> = {
  // Ethereum
  ethereum: 1, eth: 1, mainnet: 1,
  // Optimism
  optimism: 10, op: 10,
  // Cronos
  cronos: 25, cro: 25,
  // BNB / BSC
  bsc: 56, bnb: 56, "binance smart chain": 56, "bnb chain": 56,
  // Gnosis
  gnosis: 100, xdai: 100,
  // Unichain
  unichain: 130,
  // Polygon
  polygon: 137, matic: 137, pol: 137,
  // Monad
  monad: 143,
  // Sonic
  sonic: 146,
  // World Chain
  "world chain": 480, worldchain: 480, world: 480,
  // HyperEVM
  hyperevm: 999, "hyper evm": 999, hype: 999,
  // Metis
  metis: 1088,
  // Soneium
  soneium: 1868,
  // Mantle
  mantle: 5000, mnt: 5000,
  // Base
  base: 8453,
  // Plasma
  plasma: 9745,
  // Arbitrum
  arbitrum: 42161, arb: 42161, "arbitrum one": 42161,
  // Celo
  celo: 42220,
  // Avalanche
  avalanche: 43114, avax: 43114,
  // Ink
  ink: 57073,
  // Linea
  linea: 59144,
  // Berachain
  berachain: 80094, bera: 80094,
  // Blast
  blast: 81457,
  // Scroll
  scroll: 534352,
  // Solana (Delora ID)
  solana: 1000000001, sol: 1000000001,
};

export const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  10: "Optimism",
  25: "Cronos",
  56: "BSC",
  100: "Gnosis",
  130: "Unichain",
  137: "Polygon",
  143: "Monad",
  146: "Sonic",
  480: "World Chain",
  999: "HyperEVM",
  1088: "Metis",
  1868: "Soneium",
  5000: "Mantle",
  8453: "Base",
  9745: "Plasma",
  42161: "Arbitrum",
  42220: "Celo",
  43114: "Avalanche",
  57073: "Ink",
  59144: "Linea",
  80094: "Berachain",
  81457: "Blast",
  534352: "Scroll",
  1000000001: "Solana",
};

export const NATIVE_SYMBOLS: Record<number, string> = {
  1: "ETH",
  10: "ETH",
  25: "CRO",
  56: "BNB",
  100: "xDAI",
  130: "ETH",
  137: "POL",
  143: "MON",
  146: "S",
  480: "ETH",
  999: "HYPE",
  1088: "METIS",
  1868: "ETH",
  5000: "MNT",
  8453: "ETH",
  9745: "XPL",
  42161: "ETH",
  42220: "CELO",
  43114: "AVAX",
  57073: "ETH",
  59144: "ETH",
  80094: "BERA",
  81457: "ETH",
  534352: "ETH",
  1000000001: "SOL",
};

export const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";

export const NATIVE_DECIMALS: Record<number, number> = {
  1000000001: 9,  // SOL (lamports)
};

export function resolveChainId(name: string): number | null {
  return CHAIN_IDS[name.toLowerCase().trim()] ?? null;
}

export function toWei(amount: string, decimals: number): string {
  const [whole, frac = ""] = amount.split(".");
  const padded = frac.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole + padded).toString();
}
