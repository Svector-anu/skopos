// EVM tx-decoding helpers shared by every chain-data source (lib/alchemy.ts's
// JSON-RPC path, lib/blockscout.ts's REST path) — kept out of both so neither
// has to import the other just to reuse method-signature lookup / approve
// decoding, which would create a circular dependency.

// ── known 4-byte method signatures ────────────────────────────────────────────
export const METHOD_SIGS: Record<string, string> = {
  "0xa9059cbb": "transfer",
  "0x23b872dd": "transferFrom",
  "0x095ea7b3": "approve",
  "0x38ed1739": "swapExactTokensForTokens",
  "0x7ff36ab5": "swapExactETHForTokens",
  "0x18cbafe5": "swapExactTokensForETH",
  "0x5c11d795": "swapExactTokensForTokensSupportingFeeOnTransferTokens",
  "0xb6f9de95": "swapExactETHForTokensSupportingFeeOnTransferTokens",
  "0x791ac947": "swapExactTokensForETHSupportingFeeOnTransferTokens",
  "0x3593564c": "execute (Universal Router)",
  "0x5ae401dc": "multicall (Uniswap v3)",
  "0xac9650d8": "multicall",
  "0x12aa3caf": "swap (1inch)",
  "0x2e95b6c8": "unoswap (1inch)",
  "0xe8e33700": "addLiquidity",
  "0xf305d719": "addLiquidityETH",
  "0xbaa2abde": "removeLiquidity",
  "0x02751cec": "removeLiquidityETH",
  "0x6af479b2": "sellToUniswap (0x)",
  "0x0d5f0e3b": "fillLimitOrder (0x)",
};

// Decode an ERC-20 approve(address spender, uint256 amount) call.
// Layout: 0x095ea7b3 | spender (32B, right-aligned 20B) | amount (32B).
// Anything >= 2^255 is treated as unlimited — covers type(uint256).max and the
// common "infinite" allowances that make wallet-drainer approvals dangerous.
// 2^255 — an allowance at or above this is effectively unlimited (covers
// type(uint256).max). Built via the BigInt constructor, not a `255n` literal,
// since the project's tsconfig target predates BigInt literals.
const UNLIMITED_APPROVAL_MIN = BigInt("57896044618658097711785492504343953926634992332820282019728792003956564819968");

export function decodeApprove(input: string | undefined): { spender: string; unlimited: boolean } | null {
  if (!input || input.length < 138) return null;
  const spender = ("0x" + input.slice(34, 74)).toLowerCase();
  let amount: bigint;
  try {
    amount = BigInt("0x" + input.slice(74, 138));
  } catch {
    return null;
  }
  return { spender, unlimited: amount >= UNLIMITED_APPROVAL_MIN };
}
