import { fetchWithTimeout } from "./http";
import { ALCHEMY_CHAINS } from "./alchemy";
import { NATIVE_ADDRESS } from "./chains";
import { getToken } from "./delora";
import { resolveRobinhoodToken, RH_CHAIN_STABLECOIN, ARC_CHAIN_ID } from "./flash";

// Picks which chain a chain-less advanced order should run on, by reading the
// wallet's actual balance of the asset it would spend. Advanced orders used to
// default to Robinhood Chain unconditionally — correct when Flash support was
// Robinhood-only, wrong once the order types reached eight chains, since a
// wallet holding ETH on Base got an unfillable order on a chain it has never
// touched.

const ROBINHOOD_CHAIN_ID = 4663;
const ROBINHOOD_RPC = "https://rpc.mainnet.chain.robinhood.com";
const ARC_RPC = "https://rpc.mainnet.arc.io";

// Same eight chains as FLASH_ADVANCED_ORDER_CHAINS in the chat route. Kept as
// a plain map of RPC endpoints because this module only needs to read
// balances, never to build a Flash request.
const FLASH_ORDER_RPCS: Record<number, string> = {
  1: ALCHEMY_CHAINS[1].rpc,
  8453: ALCHEMY_CHAINS[8453].rpc,
  42161: ALCHEMY_CHAINS[42161].rpc,
  10: ALCHEMY_CHAINS[10].rpc,
  137: ALCHEMY_CHAINS[137].rpc,
  56: ALCHEMY_CHAINS[56].rpc,
  43114: ALCHEMY_CHAINS[43114].rpc,
  [ROBINHOOD_CHAIN_ID]: ROBINHOOD_RPC,
  [ARC_CHAIN_ID]: ARC_RPC,
};

const CHAIN_DISPLAY: Record<number, string> = {
  1: "Ethereum", 8453: "Base", 42161: "Arbitrum", 10: "Optimism",
  [ARC_CHAIN_ID]: "Arc",
  137: "Polygon", 56: "BSC", 43114: "Avalanche",
  [ROBINHOOD_CHAIN_ID]: "Robinhood Chain",
};

const NATIVE_SYMBOL: Record<number, string> = {
  1: "ETH", 8453: "ETH", 42161: "ETH", 10: "ETH",
  // Arc pays gas in USDC — Circle's whole point.
  [ARC_CHAIN_ID]: "USDC",
  137: "POL", 56: "BNB", 43114: "AVAX",
  [ROBINHOOD_CHAIN_ID]: "ETH",
};

const BALANCE_OF_SELECTOR = "0x70a08231";

export interface FundingChain {
  chainId: number;
  chainName: string;
  balance: number;
}

export interface FundingScan {
  funded: FundingChain[];
  // Chains whose balance could not be read at all (missing Alchemy key, RPC
  // down, token lookup failed). Zero balance and "couldn't look" must never
  // collapse into the same answer — telling someone they hold nothing when we
  // simply failed to check is worse than admitting the gap.
  unreadable: number;
}

async function rpcCall<T>(url: string, method: string, params: unknown[]): Promise<T | null> {
  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.error) return null;
    return json.result as T;
  } catch {
    return null;
  }
}

function hexToFloat(hex: string | null, decimals: number): number {
  if (!hex || hex === "0x" || hex === "0x0") return 0;
  let raw: bigint;
  try {
    raw = BigInt(hex);
  } catch {
    return 0;
  }
  const divisor = BigInt(10) ** BigInt(decimals);
  return Number(raw / divisor) + Number(raw % divisor) / Number(divisor);
}

// Native coin and ERC-20 both, resolved the same way the order path itself
// resolves assets — Robinhood through its registry-first resolver, everywhere
// else through Delora's token list (both already cached).
// null means the balance could not be determined — distinct from a real zero.
async function balanceOfSymbol(
  address: string,
  chainId: number,
  symbol: string,
): Promise<number | null> {
  const rpc = FLASH_ORDER_RPCS[chainId];
  if (!rpc || /\/v2\/(undefined|null)?$/.test(rpc)) return null;
  const sym = symbol.toUpperCase();

  // A wrapped-native balance is spendable for orders but invisible to anyone
  // asking "do I have ETH here", so the native read stands in for both. Flash
  // wraps on the way into the order.
  if (sym === NATIVE_SYMBOL[chainId] || sym === `W${NATIVE_SYMBOL[chainId]}`) {
    const hex = await rpcCall<string>(rpc, "eth_getBalance", [address, "latest"]);
    return hex === null ? null : hexToFloat(hex, 18);
  }

  let tokenAddress: string | null = null;
  let decimals = 18;
  if (chainId === ROBINHOOD_CHAIN_ID) {
    tokenAddress = await resolveRobinhoodToken(symbol);
    if (sym === RH_CHAIN_STABLECOIN.toUpperCase()) decimals = 6;
    // The registry resolver returns null both for "no such token here" and for
    // a failed lookup; treating it as a real zero is the safer of the two.
    if (!tokenAddress) return 0;
  } else {
    try {
      const token = await getToken(chainId, sym);
      tokenAddress = token?.address ?? null;
      decimals = token?.decimals ?? 18;
    } catch {
      return null;
    }
    if (!tokenAddress) return 0;
  }
  if (tokenAddress === NATIVE_ADDRESS) return 0;

  const data = `${BALANCE_OF_SELECTOR}${address.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
  const hex = await rpcCall<string>(rpc, "eth_call", [{ to: tokenAddress, data }, "latest"]);
  return hex === null ? null : hexToFloat(hex, decimals);
}

// Every supported chain where the wallet holds at least `needed` of `symbol`,
// balance-descending. An empty result means the order can't be funded anywhere
// — the caller says so rather than picking a chain and letting the quote fail.
export async function findFundingChains(
  address: string,
  symbol: string,
  needed: number,
): Promise<FundingScan> {
  const ids = Object.keys(FLASH_ORDER_RPCS).map(Number);
  const balances = await Promise.all(
    ids.map(async (chainId) => ({
      chainId,
      chainName: CHAIN_DISPLAY[chainId] ?? String(chainId),
      balance: await balanceOfSymbol(address, chainId, symbol).catch(() => null),
    })),
  );
  return {
    funded: balances
      .filter((b): b is FundingChain => b.balance !== null && b.balance >= needed && b.balance > 0)
      .sort((a, b) => b.balance - a.balance),
    unreadable: balances.filter((b) => b.balance === null).length,
  };
}
