import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import type { TxData, Transfer, ChainBalance, TokenBalance, AddressData } from "./alchemy-types";
import { getPrices } from "./priceCache";
import { fetchWithTimeout } from "./http";
export type { TxData, Transfer, ChainBalance, TokenBalance, AddressData };

const KEY = process.env.ALCHEMY_API_KEY ?? "";

// alchemyErc20: true  → supports alchemy_getTokenBalances / alchemy_getTokenMetadata
// alchemyErc20: false → public RPC, native balance only
export const ALCHEMY_CHAINS: Record<number, { name: string; rpc: string; nativeSymbol: string; explorer: string; alchemyErc20: boolean }> = {
  1:      { name: "Ethereum",  nativeSymbol: "ETH",  explorer: "https://etherscan.io",             rpc: `https://eth-mainnet.g.alchemy.com/v2/${KEY}`,      alchemyErc20: true  },
  8453:   { name: "Base",      nativeSymbol: "ETH",  explorer: "https://basescan.org",             rpc: `https://base-mainnet.g.alchemy.com/v2/${KEY}`,     alchemyErc20: true  },
  42161:  { name: "Arbitrum",  nativeSymbol: "ETH",  explorer: "https://arbiscan.io",              rpc: `https://arb-mainnet.g.alchemy.com/v2/${KEY}`,      alchemyErc20: true  },
  10:     { name: "Optimism",  nativeSymbol: "ETH",  explorer: "https://optimistic.etherscan.io",  rpc: `https://opt-mainnet.g.alchemy.com/v2/${KEY}`,      alchemyErc20: true  },
  137:    { name: "Polygon",   nativeSymbol: "POL",  explorer: "https://polygonscan.com",          rpc: `https://polygon-mainnet.g.alchemy.com/v2/${KEY}`,  alchemyErc20: true  },
  56:     { name: "BSC",       nativeSymbol: "BNB",  explorer: "https://bscscan.com",              rpc: "https://bsc-dataseed1.binance.org",                 alchemyErc20: false },
  43114:  { name: "Avalanche", nativeSymbol: "AVAX", explorer: "https://snowtrace.io",             rpc: "https://api.avax.network/ext/bc/C/rpc",            alchemyErc20: false },
  324:    { name: "zkSync Era",nativeSymbol: "ETH",  explorer: "https://explorer.zksync.io",       rpc: `https://zksync-mainnet.g.alchemy.com/v2/${KEY}`,   alchemyErc20: true  },
  59144:  { name: "Linea",     nativeSymbol: "ETH",  explorer: "https://lineascan.build",          rpc: `https://linea-mainnet.g.alchemy.com/v2/${KEY}`,    alchemyErc20: true  },
  100:    { name: "Gnosis",    nativeSymbol: "XDAI", explorer: "https://gnosisscan.io",            rpc: "https://rpc.gnosischain.com",                      alchemyErc20: false },
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

// Decode an ERC-20 approve(address spender, uint256 amount) call.
// Layout: 0x095ea7b3 | spender (32B, right-aligned 20B) | amount (32B).
// Anything >= 2^255 is treated as unlimited — covers type(uint256).max and the
// common "infinite" allowances that make wallet-drainer approvals dangerous.
// 2^255 — an allowance at or above this is effectively unlimited (covers
// type(uint256).max). Built via the BigInt constructor, not a `255n` literal,
// since the project's tsconfig target predates BigInt literals.
const UNLIMITED_APPROVAL_MIN = BigInt("57896044618658097711785492504343953926634992332820282019728792003956564819968");

function decodeApprove(input: string | undefined): { spender: string; unlimited: boolean } | null {
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

// ── internal helpers ──────────────────────────────────────────────────────────

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetchWithTimeout(url, {
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

function hexBalanceToFloat(hex: string, decimals: number): number {
  if (!hex || hex === "0x0") return 0;
  const raw = BigInt(hex);
  const divisor = BigInt(10 ** decimals);
  const whole = raw / divisor;
  const remainder = raw % divisor;
  return Number(whole) + Number(remainder) / 10 ** decimals;
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
      const approval   = method === "approve" ? decodeApprove(tx.input) : null;
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
        approval,
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
    fetchWithTimeout(ethRpc, {
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

  // ERC-20 balances — Alchemy chains + Ankr for non-Alchemy chains, in parallel
  const activeAlchemyChainIds = new Set([
    ...balances.filter(b => ALCHEMY_CHAINS[b.chainId]?.alchemyErc20).map(b => b.chainId),
    1,    // always include Ethereum
    8453, // and Base
    // Always include chains with a GUARANTEED_TOKENS entry — otherwise a
    // treasury holding only ARB with zero native ETH sitting on Arbitrum
    // never gets scanned for tokens there at all (found live: this exact
    // case silently skipped chainId 42161 entirely, guaranteed-check code
    // included, since it never ran).
    ...Object.keys(GUARANTEED_TOKENS).map(Number),
  ]);

  const [tokenResults, ankrTokens] = await Promise.all([
    Promise.allSettled([...activeAlchemyChainIds].map(chainId => fetchErc20Balances(address, chainId))),
    fetchAnkrBalances(address),
  ]);

  const tokenBalances: TokenBalance[] = [
    ...tokenResults.flatMap(r => r.status === "fulfilled" ? r.value : []),
    ...ankrTokens,
  ]
    .filter(t => parseFloat(t.balance) > 0)
    .sort((a, b) => parseFloat(b.balance) - parseFloat(a.balance));

  // Price enrichment — non-critical, runs in parallel
  const [nativePrices, tokenPriceMap] = await Promise.all([
    fetchNativePrices([...new Set(balances.map(b => b.nativeSymbol))]),
    fetchTokenPricesByAddress(tokenBalances.map(t => t.contractAddress)),
  ]);

  const enrichedBalances = balances.map(b => {
    const price = nativePrices[b.nativeSymbol];
    const usdValue = price != null ? parseFloat(b.native) * price : undefined;
    return { ...b, usdPrice: price, usdValue };
  });

  // Major stablecoins skip the generic DexScreener-by-address lookup entirely.
  // That lookup has no chain filter, and the same contract address can belong
  // to a completely different (often illiquid) token on another chain — found
  // this exact collision live: Ethereum USDC's address priced at $0.0006 via
  // whatever unrelated pool DexScreener matched globally. A stablecoin is
  // reasonably ~$1 by design; assuming that here is safer than a lookup that
  // can silently substitute the wrong asset's price.
  const KNOWN_STABLE_SYMBOLS = new Set(["USDC", "USDT", "DAI"]);

  const enrichedTokenBalances = tokenBalances.map(t => {
    if (KNOWN_STABLE_SYMBOLS.has(t.symbol)) {
      return { ...t, usdPrice: 1, usdValue: parseFloat(t.balance), priceChange24h: undefined };
    }
    const data = tokenPriceMap.get(t.contractAddress.toLowerCase());
    const price = data?.price;
    const usdValue = price != null ? parseFloat(t.balance) * price : undefined;
    return { ...t, usdPrice: price, usdValue, priceChange24h: data?.change24h ?? undefined };
  });

  const totalUsdValue =
    enrichedBalances.reduce((s, b) => s + (b.usdValue ?? 0), 0) +
    enrichedTokenBalances.reduce((s, t) => s + (t.usdValue ?? 0), 0);

  return {
    address,
    balances: enrichedBalances,
    tokenBalances: enrichedTokenBalances.sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0)),
    recentTransfers,
    totalUsdValue: totalUsdValue > 0 ? totalUsdValue : undefined,
  };
}

// ── Price helpers ─────────────────────────────────────────────────────────────

async function fetchNativePrices(symbols: string[]): Promise<Record<string, number>> {
  const unique = [...new Set(symbols)].filter(Boolean);
  if (unique.length === 0) return {};
  try {
    const priceData = await getPrices(unique);
    const out: Record<string, number> = {};
    for (const sym of unique) {
      if (priceData[sym]?.price) out[sym] = priceData[sym].price;
    }
    return out;
  } catch {
    return {};
  }
}

interface TokenPriceData { price: number; change24h: number | null }

async function fetchTokenPricesByAddress(addresses: string[]): Promise<Map<string, TokenPriceData>> {
  const priceMap = new Map<string, TokenPriceData>();
  const unique = [...new Set(addresses.map(a => a.toLowerCase()))].filter(Boolean).slice(0, 30);
  if (unique.length === 0) return priceMap;
  try {
    const res = await fetchWithTimeout(
      `https://api.dexscreener.com/latest/dex/tokens/${unique.join(",")}`
    );
    if (!res.ok) return priceMap;
    const data = await res.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pairs: any[] = data.pairs ?? [];
    const liqTrack = new Map<string, number>();
    for (const pair of pairs) {
      const addr = (pair.baseToken?.address ?? "").toLowerCase();
      if (!addr || !pair.priceUsd) continue;
      const liq = pair.liquidity?.usd ?? 0;
      if (liq > (liqTrack.get(addr) ?? 0)) {
        liqTrack.set(addr, liq);
        priceMap.set(addr, {
          price: parseFloat(pair.priceUsd),
          change24h: pair.priceChange?.h24 ?? null,
        });
      }
    }
  } catch {
    // price enrichment is non-critical
  }
  return priceMap;
}

// ── Ankr multichain — covers chains Alchemy doesn't support ──────────────────

const ANKR_CHAINS: { ankrName: string; chainId: number; name: string }[] = [
  { ankrName: "bsc",       chainId: 56,    name: "BSC"       },
  { ankrName: "avalanche", chainId: 43114, name: "Avalanche" },
  { ankrName: "gnosis",    chainId: 100,   name: "Gnosis"    },
];

async function fetchAnkrBalances(address: string): Promise<TokenBalance[]> {
  try {
    const res = await fetchWithTimeout("https://rpc.ankr.com/multichain/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "ankr_getAccountBalance",
        params: {
          walletAddress: address,
          blockchain: ANKR_CHAINS.map(c => c.ankrName),
          onlyWhitelisted: false,
          pageSize: 50,
        },
      }),
    });
    if (!res.ok) return [];
    const json = await res.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const assets: any[] = json?.result?.assets ?? [];

    const out: TokenBalance[] = [];
    for (const a of assets) {
      if (a.tokenType === "NATIVE") continue; // native already fetched via eth_getBalance
      const chainMeta = ANKR_CHAINS.find(c => c.ankrName === a.blockchain);
      if (!chainMeta) continue;
      const balance = parseFloat(String(a.balance ?? "0"));
      if (balance <= 0) continue;
      out.push({
        contractAddress: String(a.contractAddress ?? ""),
        symbol:    String(a.tokenSymbol ?? ""),
        name:      String(a.tokenName ?? a.tokenSymbol ?? ""),
        decimals:  Number(a.tokenDecimals ?? 18),
        balance:   balance.toFixed(4),
        chainId:   chainMeta.chainId,
        chainName: chainMeta.name,
      });
    }
    return out;
  } catch {
    return [];
  }
}

// Verified addresses only — a wrong entry here would misreport a real balance.
// Started as stablecoins-only; extended to a chain's own major governance
// token when a curated DAO treasury (route.ts's DAO_TREASURIES) turned out to
// hold it in enough size that missing it wasn't just an undercount, it was a
// wrong answer (Arbitrum DAO's treasury reported ~$151 instead of ~$1.5B+
// until ARB was added here — confirmed via live testing, not assumed).
const GUARANTEED_TOKENS: Partial<Record<number, Array<{ address: string; symbol: string; name: string; decimals: number }>>> = {
  1: [
    { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", name: "USD Coin", decimals: 6 },
    { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", name: "Tether USD", decimals: 6 },
    { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", symbol: "DAI", name: "Dai Stablecoin", decimals: 18 },
  ],
  42161: [
    { address: "0x912CE59144191C1204E64559FE8253a0e49E6548", symbol: "ARB", name: "Arbitrum", decimals: 18 },
  ],
};

// Direct balanceOf() calls for known-major tokens, bypassing Alchemy's
// arbitrary (not value-sorted) token list entirely — a guaranteed check so a
// real, high-value holding can never be silently buried behind
// spam-airdropped tokens, regardless of how many an address has accumulated.
async function fetchGuaranteedTokenBalances(address: string, chainId: number): Promise<TokenBalance[]> {
  const chain = ALCHEMY_CHAINS[chainId];
  const tokens = GUARANTEED_TOKENS[chainId];
  if (!chain || !tokens) return [];

  const paddedAddress = address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const calldata = `0x70a08231${paddedAddress}`;

  const results = await Promise.allSettled(
    tokens.map(t => rpc<string>(chain.rpc, "eth_call", [{ to: t.address, data: calldata }, "latest"]))
  );

  const out: TokenBalance[] = [];
  tokens.forEach((t, i) => {
    const r = results[i];
    if (r.status !== "fulfilled" || !r.value || r.value === "0x") return;
    const balance = hexBalanceToFloat(r.value, t.decimals);
    if (balance <= 0) return;
    out.push({
      contractAddress: t.address,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      balance: balance.toFixed(4),
      chainId,
      chainName: chain.name,
    });
  });
  return out;
}

async function fetchErc20Balances(address: string, chainId: number): Promise<TokenBalance[]> {
  const chain = ALCHEMY_CHAINS[chainId];
  if (!chain || !chain.alchemyErc20) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await rpc<any>(chain.rpc, "alchemy_getTokenBalances", [address, "erc20"]);
  if (!result?.tokenBalances) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nonZero: any[] = result.tokenBalances.filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (t: any) => t.tokenBalance && t.tokenBalance !== "0x0000000000000000000000000000000000000000000000000000000000000000"
  );

  // Fetch metadata for up to 20 tokens in parallel to keep latency reasonable.
  // Alchemy's order here is arbitrary, not USD-value-sorted — a high-profile
  // address (a DAO treasury, an exchange hot wallet) accumulates hundreds of
  // spam-airdropped tokens over time, which can bury a real, high-value
  // holding past position 8. 20 plus the spam filter below catches real
  // holdings far more reliably without fetching metadata for everything.
  const top = nonZero.slice(0, 20);
  const metaResults = await Promise.allSettled(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    top.map((t: any) => rpc<any>(chain.rpc, "alchemy_getTokenMetadata", [t.contractAddress]))
  );

  const out: TokenBalance[] = [];
  for (let i = 0; i < top.length; i++) {
    const meta = metaResults[i];
    if (meta.status !== "fulfilled" || !meta.value) continue;
    const { decimals, symbol, name } = meta.value;
    if (!decimals || !symbol) continue;
    const balance = hexBalanceToFloat(top[i].tokenBalance, decimals).toFixed(4);
    if (parseFloat(balance) <= 0) continue;
    out.push({
      contractAddress: top[i].contractAddress as string,
      symbol:    symbol as string,
      name:      (name ?? symbol) as string,
      decimals:  decimals as number,
      balance,
      chainId,
      chainName: chain.name,
    });
  }
  // Filter obvious airdrop spam (fake "claim your reward" tokens abusing the
  // symbol/name field as an ad) before it can crowd out real holdings in the
  // final top-N the caller displays.
  const SPAM_PATTERN = /https?:\/\/|www\.|\.(?:com|org|io|xyz|net|app)\b|claim|reward|airdrop/i;
  const filtered = out.filter(t => !SPAM_PATTERN.test(t.symbol) && !SPAM_PATTERN.test(t.name));

  // Guaranteed check for major stablecoins — even 20 candidates can be entirely
  // spam on a heavily-airdropped address (verified against a real DAO treasury
  // during testing: USDC was missing at 20, not just at 8). Merge in, deduped.
  const known = await fetchGuaranteedTokenBalances(address, chainId);
  const seen = new Set(filtered.map(t => t.contractAddress.toLowerCase()));
  for (const t of known) {
    if (!seen.has(t.contractAddress.toLowerCase())) filtered.push(t);
  }
  return filtered;
}
