export const CHAIN_IDS: Record<string, number> = {
  ethereum: 1, eth: 1,
  optimism: 10, op: 10,
  bsc: 56, bnb: 56, "binance smart chain": 56,
  gnosis: 100, xdai: 100,
  polygon: 137, matic: 137, pol: 137,
  unichain: 130,
  monad: 143,
  sonic: 146,
  "world chain": 480, worldchain: 480,
  metis: 1088,
  soneium: 1868,
  mantle: 5000, mnt: 5000,
  base: 8453, bas: 8453,
  arbitrum: 42161, arb: 42161, "arbitrum one": 42161,
  celo: 42220,
  avalanche: 43114, avax: 43114,
  ink: 57073,
  linea: 59144,
  berachain: 80094, bera: 80094,
  blast: 81457,
  scroll: 534352,
};

export const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  10: "Optimism",
  56: "BSC",
  100: "Gnosis",
  130: "Unichain",
  137: "Polygon",
  143: "Monad",
  146: "Sonic",
  480: "World Chain",
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
};

export const NATIVE_SYMBOLS: Record<number, string> = {
  1: "ETH", 10: "ETH", 56: "BNB", 100: "xDAI", 130: "ETH",
  137: "POL", 143: "MON", 146: "S", 480: "ETH", 999: "HYPE",
  1088: "METIS", 1868: "ETH", 5000: "MNT", 8453: "ETH", 9745: "XPL",
  42161: "ETH", 42220: "CELO", 43114: "AVAX", 57073: "ETH",
  59144: "ETH", 80094: "BERA", 81457: "ETH", 534352: "ETH",
};

export const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";

export function resolveChainId(name: string): number | null {
  return CHAIN_IDS[name.toLowerCase().trim()] ?? null;
}

export function toWei(amount: string, decimals: number): string {
  const [whole, frac = ""] = amount.split(".");
  const padded = frac.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole + padded).toString();
}
