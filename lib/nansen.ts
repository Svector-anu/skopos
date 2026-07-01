// DexScreener chain slug → Nansen chain slug. Kept deliberately to chains whose
// Nansen slug is confirmed, because Token God Mode validates the chain only AFTER
// the x402 payment settles — an unknown slug means the payer pays and then gets a
// 422. Extend only with chains verified against a live paid call.
const NANSEN_CHAIN_BY_DEX: Record<string, string> = {
  ethereum: "ethereum",
  base:     "base",
  solana:   "solana",
  arbitrum: "arbitrum",
  polygon:  "polygon",
};

export function toNansenChain(dexChainId: string): string | null {
  return NANSEN_CHAIN_BY_DEX[dexChainId.toLowerCase()] ?? null;
}
