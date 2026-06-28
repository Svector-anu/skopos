import { createPublicClient, http, isAddress, getAddress, parseUnits, stringToHex, keccak256, toHex } from "viem";
import { base, baseSepolia } from "viem/chains";

// B20 memo payments. A B20 token is an ERC-20 superset with transferWithMemo —
// a transfer that emits Memo(caller, bytes32) right after Transfer, so a payment
// carries a machine-reconcilable reference (invoice/order id). Skopos builds the
// call; the user signs it client-side (non-custodial). Reads use a base-reth RPC
// (the public Base RPC is fine post-Beryl).

export const TRANSFER_WITH_MEMO_ABI = [
  {
    name: "transferWithMemo",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "memo", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const ERC20_META_ABI = [
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

const CHAINS = { 8453: base, 84532: baseSepolia } as const;
type PayChainId = keyof typeof CHAINS;

const CHAIN_ALIAS: Record<string, PayChainId> = {
  base: 8453, "base mainnet": 8453, mainnet: 8453,
  "base sepolia": 84532, "base-sepolia": 84532, sepolia: 84532, testnet: 84532,
};

function makeClient(chainId: PayChainId) {
  return createPublicClient({ chain: CHAINS[chainId], transport: http() });
}
const clients = new Map<PayChainId, ReturnType<typeof makeClient>>();
function clientFor(chainId: PayChainId) {
  let c = clients.get(chainId);
  if (!c) {
    c = makeClient(chainId);
    clients.set(chainId, c);
  }
  return c;
}

// Memo is bytes32. Short refs go in literally; anything over 31 bytes is keccak'd
// so the on-chain tag is still a stable, verifiable fingerprint of the text.
function encodeMemo(text: string): { memo: `0x${string}`; hashed: boolean } {
  if (!text) return { memo: `0x${"0".repeat(64)}`, hashed: false };
  if (new TextEncoder().encode(text).length <= 31) return { memo: stringToHex(text, { size: 32 }), hashed: false };
  return { memo: keccak256(toHex(text)), hashed: true };
}

export interface PayIntent {
  token: `0x${string}`;
  tokenSymbol: string;
  decimals: number;
  to: `0x${string}`;
  amountWei: string;
  amountDisplay: string;
  memo: `0x${string}`;
  memoText: string;
  memoHashed: boolean;
  chainId: number;
  chainName: string;
}

const PAY_RE = /^(?:pay|send|transfer)\s+([\d.]+)\s+(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]*)\s+to\s+(0x[a-fA-F0-9]{40})(?:\s+(?:for|memo|tag|ref|note|re)\s+(.+?))?(?:\s+on\s+([a-z][a-z\s-]*?))?\s*$/i;

export function looksLikePay(input: string): boolean {
  return PAY_RE.test(input.trim());
}

export async function buildPayIntent(input: string): Promise<PayIntent | { error: string } | null> {
  const m = input.trim().match(PAY_RE);
  if (!m) return null;

  const [, amount, tokenRef, to, memoRaw, chainRaw] = m;
  const chainId = CHAIN_ALIAS[(chainRaw ?? "base").trim().toLowerCase()];
  if (!chainId) return { error: `B20 payments are on Base and Base Sepolia for now — "${(chainRaw ?? "").trim()}" isn't supported yet.` };
  if (!isAddress(to)) return { error: `That recipient address isn't valid.` };
  if (!isAddress(tokenRef)) return { error: `Give the token's contract address (e.g. a 0xb20… B20 address). Symbol lookup for B20 tokens is coming.` };

  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return { error: `Amount must be a positive number.` };

  const token = getAddress(tokenRef);
  const client = clientFor(chainId);
  let decimals: number;
  let symbol: string;
  try {
    [decimals, symbol] = await Promise.all([
      client.readContract({ address: token, abi: ERC20_META_ABI, functionName: "decimals" }) as Promise<number>,
      client.readContract({ address: token, abi: ERC20_META_ABI, functionName: "symbol" }) as Promise<string>,
    ]);
  } catch {
    return { error: `Couldn't read that token on ${CHAINS[chainId].name} — check the address and chain.` };
  }

  const { memo, hashed: memoHashed } = encodeMemo((memoRaw ?? "").trim());
  return {
    token,
    tokenSymbol: symbol,
    decimals,
    to: getAddress(to),
    amountWei: parseUnits(amount, decimals).toString(),
    amountDisplay: amount,
    memo,
    memoText: (memoRaw ?? "").trim(),
    memoHashed,
    chainId,
    chainName: CHAINS[chainId].name,
  };
}
