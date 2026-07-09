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

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Validates a {address, chain} pair BEFORE it's spent against the paid,
// x402-metered Nansen call — Token God Mode only validates the chain/address
// after payment settles, so an invalid pair here otherwise means paying for a
// guaranteed 422.
export function isValidTokenTarget(address: string, chain: string): boolean {
  const nansenChain = toNansenChain(chain);
  if (!nansenChain) return false;
  return nansenChain === "solana" ? SOLANA_ADDRESS_RE.test(address) : EVM_ADDRESS_RE.test(address);
}
