import { createPublicClient, http, isAddress, getAddress, parseUnits, stringToHex, keccak256, toHex } from "viem";
import { base, baseSepolia } from "viem/chains";
import { getToken } from "./delora";

// B20 memo payments. A B20 token is an ERC-20 superset with transferWithMemo —
// a transfer that emits Memo(caller, bytes32) right after Transfer, so a payment
// carries a machine-reconcilable reference (invoice/order id). Skopos builds the
// call; the user signs it client-side (non-custodial). Reads use a base-reth RPC
// (the public Base RPC is fine post-Beryl).

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

// Verified-address shortcuts for common tokens. Symbols not here fall through to
// Delora's global token list (mainnet coverage); testnet symbols rely on this map.
const KNOWN_TOKENS: Record<PayChainId, Record<string, `0x${string}`>> = {
  8453: {
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    WETH: "0x4200000000000000000000000000000000000006",
  },
  84532: {
    USDC: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    MYT:  "0xb200000000000000000000b4cd6Cd5af9e950652",
  },
};

// B20 tokens live at deterministic 0xb200… addresses. Only B20s have
// transferWithMemo; a plain ERC-20 falls back to transfer() with no memo.
function isB20Address(addr: string): boolean {
  return addr.toLowerCase().startsWith("0xb200");
}

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
  method: "transferWithMemo" | "transfer";
  isB20: boolean;
  memoApplied: boolean;
  chainId: number;
  chainName: string;
}

const ERC20_DECIMALS_SYMBOL_ABI = ERC20_META_ABI;

// Resolve a "USDC" / "MYT" / 0xADDRESS reference to a concrete token. Known map
// first, then the chain's on-chain metadata; for symbols, Delora's global list
// (mainnet) before giving up.
async function resolveToken(chainId: PayChainId, ref: string): Promise<{ token: `0x${string}`; decimals: number; symbol: string } | null> {
  const client = clientFor(chainId);
  const readMeta = async (token: `0x${string}`) => {
    const [decimals, symbol] = await Promise.all([
      client.readContract({ address: token, abi: ERC20_DECIMALS_SYMBOL_ABI, functionName: "decimals" }) as Promise<number>,
      client.readContract({ address: token, abi: ERC20_DECIMALS_SYMBOL_ABI, functionName: "symbol" }) as Promise<string>,
    ]);
    return { token, decimals, symbol };
  };

  if (isAddress(ref)) {
    try { return await readMeta(getAddress(ref)); } catch { return null; }
  }

  const known = KNOWN_TOKENS[chainId]?.[ref.toUpperCase()];
  if (known) {
    try { return await readMeta(known); } catch { return null; }
  }

  try {
    const t = await getToken(chainId, ref);
    if (t && isAddress(t.address)) return { token: getAddress(t.address), decimals: t.decimals, symbol: t.symbol };
  } catch { /* Delora unavailable / not on this chain */ }

  return null;
}

// Recipient is captured loosely (0x + any hex) so a malformed/typo address still
// classifies as a payment and gets a clear "invalid recipient" error in
// buildPayIntent, instead of falling through to a confusing swap-parse error.
const PAY_RE = /^(?:pay|send|transfer)\s+([\d.]+)\s+(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]*)\s+to\s+(0x[a-fA-F0-9]{4,})(?:\s+(?:for|memo|tag|ref|note|re)\s+(.+?))?(?:\s+on\s+([a-z][a-z\s-]*?))?\s*$/i;

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

  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return { error: `Amount must be a positive number.` };

  const resolved = await resolveToken(chainId, tokenRef);
  if (!resolved) return { error: `Couldn't resolve "${tokenRef}" on ${CHAINS[chainId].name}. Try the token's contract address.` };
  const { token, decimals, symbol } = resolved;

  const isB20 = isB20Address(token);
  const memoText = (memoRaw ?? "").trim();
  const { memo, hashed: memoHashed } = encodeMemo(memoText);
  const memoApplied = isB20 && memoText.length > 0;

  return {
    token,
    tokenSymbol: symbol,
    decimals,
    to: getAddress(to),
    amountWei: parseUnits(amount, decimals).toString(),
    amountDisplay: amount,
    memo,
    memoText,
    memoHashed,
    method: isB20 ? "transferWithMemo" : "transfer",
    isB20,
    memoApplied,
    chainId,
    chainName: CHAINS[chainId].name,
  };
}
