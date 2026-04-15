import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import type { TxData, Transfer, ChainBalance, AddressData } from "./alchemy-types";
export type { TxData, Transfer, ChainBalance, AddressData };

const KEY = process.env.ALCHEMY_API_KEY ?? "";

export const ALCHEMY_CHAINS: Record<number, { name: string; rpc: string; nativeSymbol: string; explorer: string }> = {
  1:     { name: "Ethereum", nativeSymbol: "ETH", explorer: "https://etherscan.io",              rpc: `https://eth-mainnet.g.alchemy.com/v2/${KEY}`     },
  8453:  { name: "Base",     nativeSymbol: "ETH", explorer: "https://basescan.org",              rpc: `https://base-mainnet.g.alchemy.com/v2/${KEY}`    },
  42161: { name: "Arbitrum", nativeSymbol: "ETH", explorer: "https://arbiscan.io",               rpc: `https://arb-mainnet.g.alchemy.com/v2/${KEY}`     },
  10:    { name: "Optimism", nativeSymbol: "ETH", explorer: "https://optimistic.etherscan.io",   rpc: `https://opt-mainnet.g.alchemy.com/v2/${KEY}`     },
  137:   { name: "Polygon",  nativeSymbol: "POL", explorer: "https://polygonscan.com",           rpc: `https://polygon-mainnet.g.alchemy.com/v2/${KEY}` },
};

// ── known 4-byte method signatures ────────────────────────────────────────────
const METHOD_SIGS: Record<string, string> = {
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

// ── internal helpers ──────────────────────────────────────────────────────────

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message ?? "RPC error");
  return json.result as T;
}

function hexToNum(hex: string | null | undefined, fallback = 0): number {
  if (!hex) return fallback;
  return parseInt(hex, 16);
}

// ── ENS resolution ────────────────────────────────────────────────────────────

let _ensClient: ReturnType<typeof createPublicClient> | null = null;

function ensClient() {
  if (!_ensClient) {
    _ensClient = createPublicClient({
      chain: mainnet,
      transport: http(ALCHEMY_CHAINS[1].rpc),
    });
  }
  return _ensClient;
}

export async function resolveENS(name: string): Promise<string | null> {
  try {
    const address = await ensClient().getEnsAddress({ name });
    return address ?? null;
  } catch {
    return null;
  }
}

// ── public API ────────────────────────────────────────────────────────────────

export async function lookupTx(hash: string): Promise<TxData | null> {
  const entries = Object.entries(ALCHEMY_CHAINS);

  const results = await Promise.allSettled(
    entries.map(async ([chainIdStr, chain]) => {
      const chainId = Number(chainIdStr);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tx = await rpc<any>(chain.rpc, "eth_getTransactionByHash", [hash]);
      if (!tx) return null;

      const [receipt, block] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rpc<any>(chain.rpc, "eth_getTransactionReceipt", [hash]),
        tx.blockNumber
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? rpc<any>(chain.rpc, "eth_getBlockByNumber", [tx.blockNumber, false])
          : Promise.resolve(null),
      ]);

      const valueEth   = (hexToNum(tx.value) / 1e18).toFixed(6);
      const gasUsed    = hexToNum(receipt?.gasUsed);
      const gasPrice   = hexToNum(tx.gasPrice ?? tx.maxFeePerGas);
      const gasCostEth = ((gasUsed * gasPrice) / 1e18).toFixed(6);
      const method     = tx.input?.length >= 10 ? (METHOD_SIGS[tx.input.slice(0, 10)] ?? null) : null;
      const statusCode = receipt ? hexToNum(receipt.status) : -1;
      const status: TxData["status"] = statusCode === 1 ? "success" : statusCode === 0 ? "failed" : "pending";

      return {
        hash,
        chainId,
        chainName:   chain.name,
        explorerUrl: `${chain.explorer}/tx/${hash}`,
        from:        tx.from as string,
        to:          tx.to as string | null ?? null,
        valueEth,
        status,
        blockNumber: hexToNum(tx.blockNumber),
        gasUsed:     gasUsed.toString(),
        gasCostEth,
        method,
        timestamp:   block?.timestamp ? hexToNum(block.timestamp) : null,
        logCount:    receipt?.logs?.length ?? 0,
      } satisfies TxData;
    })
  );

  for (const r of results) {
    if (r.status === "fulfilled" && r.value) return r.value;
  }
  return null;
}

export async function lookupAddress(address: string): Promise<AddressData> {
  const entries = Object.entries(ALCHEMY_CHAINS);

  // Native balances across all chains in parallel
  const balanceResults = await Promise.allSettled(
    entries.map(async ([chainIdStr, chain]) => {
      const balance = await rpc<string>(chain.rpc, "eth_getBalance", [address, "latest"]);
      return {
        chainId:      Number(chainIdStr),
        chainName:    chain.name,
        nativeSymbol: chain.nativeSymbol,
        native:       (hexToNum(balance) / 1e18).toFixed(4),
      } satisfies ChainBalance;
    })
  );

  const balances = balanceResults
    .filter((r): r is PromiseFulfilledResult<ChainBalance> => r.status === "fulfilled")
    .map(r => r.value)
    .filter(b => parseFloat(b.native) > 0.00001);

  // Recent transfers via alchemy_getAssetTransfers (Ethereum mainnet)
  const ethRpc = ALCHEMY_CHAINS[1].rpc;

  const fetchTransfers = (direction: "in" | "out") =>
    fetch(ethRpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "alchemy_getAssetTransfers",
        params: [{
          [direction === "out" ? "fromAddress" : "toAddress"]: address,
          category: ["external", "erc20", "erc721"],
          maxCount: "0xa",
          withMetadata: false,
          order: "desc",
        }],
      }),
    }).then(r => r.json());

  const [outRes, inRes] = await Promise.allSettled([
    fetchTransfers("out"),
    fetchTransfers("in"),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapT = (t: any, direction: "in" | "out"): Transfer => ({
    hash:     t.hash as string,
    from:     t.from as string,
    to:       t.to as string | null ?? null,
    value:    t.value != null ? Number(t.value).toFixed(4) : "0",
    asset:    (t.asset ?? "ETH") as string,
    direction,
    blockNum: (t.blockNum ?? "0x0") as string,
  });

  const out = outRes.status === "fulfilled" ? (outRes.value.result?.transfers ?? []).map((t: unknown) => mapT(t, "out")) : [];
  const inn = inRes.status  === "fulfilled" ? (inRes.value.result?.transfers   ?? []).map((t: unknown) => mapT(t, "in"))  : [];

  const recentTransfers: Transfer[] = [...out, ...inn]
    .sort((a, b) => hexToNum(b.blockNum) - hexToNum(a.blockNum))
    .slice(0, 12);

  return { address, balances, recentTransfers };
}
