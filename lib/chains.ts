// NLP alias map — maps user-typed names to Delora chain IDs.
// Chain metadata (names, native tokens, decimals) comes from the Delora API via getChainById().
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
  // MegaETH
  megaeth: 4326, mega: 4326,
  // Solana (Delora ID)
  solana: 1000000001, sol: 1000000001,
  // Common compound aliases users type
  "eth mainnet": 1, "ethereum mainnet": 1,
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
