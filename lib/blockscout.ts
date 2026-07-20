import type { ChainBalance, TokenBalance, TxData, AddressReputation } from "./alchemy-types";
import { METHOD_SIGS, decodeApprove } from "./evmTx";
import { fetchWithTimeout } from "./http";

const API_KEY = process.env.BLOCKSCOUT_API_KEY ?? "";

// Chains verified live against their instance's /api/v2/addresses/{address}
// endpoint to confirm they run the actual Blockscout v2 REST schema (some
// "Blockscout" listings in the public chain registry are legacy/custom forks
// under a different host — Metis's andromeda-explorer.metis.io returned a
// different error shape and was excluded for that reason). None of these
// overlap lib/alchemy.ts's ALCHEMY_CHAINS or its Ankr fallback — this module
// exists purely to fill the gap those two leave, not to race them.
export const BLOCKSCOUT_CHAINS: Record<number, { name: string; baseUrl: string; nativeSymbol: string }> = {
  4663:   { name: "Robinhood Chain", baseUrl: "https://robinhoodchain.blockscout.com",         nativeSymbol: "ETH"  },
  130:    { name: "Unichain",        baseUrl: "https://unichain.blockscout.com",                nativeSymbol: "ETH"  },
  480:    { name: "World Chain",     baseUrl: "https://worldchain-mainnet.explorer.alchemy.com", nativeSymbol: "ETH"  },
  999:    { name: "HyperEVM",        baseUrl: "https://www.hyperscan.com",                       nativeSymbol: "HYPE" },
  1868:   { name: "Soneium",         baseUrl: "https://soneium.blockscout.com",                  nativeSymbol: "ETH"  },
  4326:   { name: "MegaETH",         baseUrl: "https://megaeth.blockscout.com",                  nativeSymbol: "ETH"  },
  42220:  { name: "Celo",            baseUrl: "https://celo.blockscout.com",                     nativeSymbol: "CELO" },
  57073:  { name: "Ink",             baseUrl: "https://explorer.inkonchain.com",                 nativeSymbol: "ETH"  },
  534352: { name: "Scroll",          baseUrl: "https://scroll.blockscout.com",                   nativeSymbol: "ETH"  },
};

// Blockscout's SaaS-hosted instances migrated key-based auth to a separate
// "PRO API" product (dev.blockscout.com) — this apikey query param is the
// documented legacy per-instance mechanism, kept as a harmless best-effort
// pass-through. Its effect against the direct instance hosts above is
// unconfirmed; unauthenticated requests worked fine in live testing (~180
// req/IP per rolling window observed on robinhoodchain.blockscout.com).
function withKey(url: string): string {
  return API_KEY ? `${url}${url.includes("?") ? "&" : "?"}apikey=${API_KEY}` : url;
}

async function bsGet<T>(baseUrl: string, path: string): Promise<T | null> {
  try {
    const res = await fetchWithTimeout(withKey(`${baseUrl}${path}`));
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// Blockscout returns balances as plain decimal-string wei (not hex, unlike
// the Alchemy/Ankr JSON-RPC paths) — BigInt() parses decimal strings directly.
function balanceToFloat(raw: string, decimals: number): number {
  const value = BigInt(raw);
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = value / divisor;
  const remainder = value % divisor;
  return Number(whole) + Number(remainder) / Number(divisor);
}

interface BsAddressInfo {
  coin_balance: string | null;
  exchange_rate: string | null;
}

interface BsTokenBalanceEntry {
  token: {
    address_hash: string;
    symbol: string;
    name: string;
    decimals: string;
    exchange_rate: string | null;
  };
  value: string;
}

interface BsActor {
  hash: string;
}

interface BsTx {
  hash: string;
  from: BsActor;
  to: BsActor | null;
  value: string;
  status: "ok" | "error" | null;
  result: string;
  block_number: number | null;
  gas_used: string | null;
  gas_price: string | null;
  method: string | null;
  raw_input: string | null;
  timestamp: string | null;
}

async function fetchOneChainBalances(
  address: string,
  chainId: number,
): Promise<{ balance: ChainBalance | null; tokens: TokenBalance[] }> {
  const chain = BLOCKSCOUT_CHAINS[chainId];
  if (!chain) return { balance: null, tokens: [] };

  // /token-balances returns every ERC-20 the address has ever touched, unpaged
  // — on a spam-heavy address that's tens of thousands of items and multiple
  // MB (found live: 36k items / ~15MB / 23s on a real RH Chain holder, blowing
  // past the 8s timeout and silently dropping every RH Chain token). /tokens
  // is the paginated, fiat-value-sorted equivalent — same per-token shape,
  // just capped at a page (50) of the holdings that actually matter.
  const [addrInfo, tokenPage] = await Promise.all([
    bsGet<BsAddressInfo>(chain.baseUrl, `/api/v2/addresses/${address}`),
    bsGet<{ items: BsTokenBalanceEntry[] }>(chain.baseUrl, `/api/v2/addresses/${address}/tokens?type=ERC-20`),
  ]);
  const tokenEntries = tokenPage?.items;

  let balance: ChainBalance | null = null;
  if (addrInfo?.coin_balance) {
    const native = balanceToFloat(addrInfo.coin_balance, 18);
    const usdPrice = addrInfo.exchange_rate ? parseFloat(addrInfo.exchange_rate) : undefined;
    balance = {
      chainId,
      chainName: chain.name,
      nativeSymbol: chain.nativeSymbol,
      native: native.toFixed(4),
      usdPrice,
      usdValue: usdPrice != null ? native * usdPrice : undefined,
    };
  }

  const tokens: TokenBalance[] = (tokenEntries ?? [])
    // Some native gas tokens (Celo's CELO) are ALSO a real ERC-20 contract at
    // the base layer, so /tokens?type=ERC-20 lists them again on top of the
    // native coin_balance fetched above — confirmed live, same balance
    // reported twice under identical values. Exclude anything matching the
    // chain's own native symbol; it's already counted via `balance` above.
    .filter(e => e.token?.address_hash && e.value && e.token.symbol !== chain.nativeSymbol)
    .map(e => {
      const decimals = Number(e.token.decimals ?? 18);
      const balanceFloat = balanceToFloat(e.value, decimals);
      const usdPrice = e.token.exchange_rate ? parseFloat(e.token.exchange_rate) : undefined;
      return {
        contractAddress: e.token.address_hash,
        symbol: e.token.symbol,
        name: e.token.name ?? e.token.symbol,
        decimals,
        balance: balanceFloat.toFixed(4),
        chainId,
        chainName: chain.name,
        usdPrice,
        usdValue: usdPrice != null ? balanceFloat * usdPrice : undefined,
      } satisfies TokenBalance;
    });

  return { balance, tokens };
}

// Fills the native + token balance gap ALCHEMY_CHAINS and its Ankr fallback
// leave — every chain in BLOCKSCOUT_CHAINS gets queried in parallel.
export async function fetchBlockscoutBalances(
  address: string,
): Promise<{ balances: ChainBalance[]; tokens: TokenBalance[] }> {
  const results = await Promise.allSettled(
    Object.keys(BLOCKSCOUT_CHAINS).map(id => fetchOneChainBalances(address, Number(id))),
  );

  const balances: ChainBalance[] = [];
  const tokens: TokenBalance[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    if (r.value.balance) balances.push(r.value.balance);
    tokens.push(...r.value.tokens);
  }
  return { balances, tokens };
}

async function fetchOneChainTx(hash: string, chainId: number): Promise<TxData | null> {
  const chain = BLOCKSCOUT_CHAINS[chainId];
  if (!chain) return null;

  const [tx, logs] = await Promise.all([
    bsGet<BsTx>(chain.baseUrl, `/api/v2/transactions/${hash}`),
    bsGet<{ items: unknown[] }>(chain.baseUrl, `/api/v2/transactions/${hash}/logs`),
  ]);
  if (!tx) return null;

  const valueEth = (balanceToFloat(tx.value ?? "0", 18)).toFixed(6);
  const gasUsed = Number(tx.gas_used ?? 0);
  const gasPrice = Number(tx.gas_price ?? 0);
  const gasCostEth = ((gasUsed * gasPrice) / 1e18).toFixed(6);
  const method = tx.method
    ?? (tx.raw_input && tx.raw_input.length >= 10 ? METHOD_SIGS[tx.raw_input.slice(0, 10)] ?? null : null);
  const status: TxData["status"] = tx.status === "ok" ? "success" : tx.status === "error" ? "failed" : "pending";

  return {
    hash,
    chainId,
    chainName: chain.name,
    explorerUrl: `${chain.baseUrl}/tx/${hash}`,
    from: tx.from.hash,
    to: tx.to?.hash ?? null,
    valueEth,
    status,
    blockNumber: tx.block_number ?? 0,
    gasUsed: gasUsed.toString(),
    gasCostEth,
    method,
    approval: method === "approve" ? decodeApprove(tx.raw_input ?? undefined) : null,
    timestamp: tx.timestamp ? Math.floor(new Date(tx.timestamp).getTime() / 1000) : null,
    // Blockscout's tx object doesn't inline a log count — this is page-1 of
    // the separate /logs endpoint, a lower bound for txs with >50 log events
    // (Alchemy's path gets an exact count via eth_getTransactionReceipt).
    logCount: logs?.items?.length ?? 0,
  } satisfies TxData;
}

// Fallback for lookupTx() once no ALCHEMY_CHAINS entry matches — races every
// BLOCKSCOUT_CHAINS instance and returns the first hit.
export async function lookupBlockscoutTx(hash: string): Promise<TxData | null> {
  const results = await Promise.allSettled(
    Object.keys(BLOCKSCOUT_CHAINS).map(id => fetchOneChainTx(hash, Number(id))),
  );
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) return r.value;
  }
  return null;
}

// ── PRO API (api.blockscout.com) ──────────────────────────────────────────────
// A separate multichain product from the free per-instance REST v2 hosts
// above — it has its own auth (mandatory `apikey`, no anonymous tier) and its
// own chain coverage, which per Blockscout's docs spans "all supported
// chains," not just the BLOCKSCOUT_CHAINS gap list (their own example queries
// chain_id=1 and chain_id=8453 — Ethereum and Base, both already covered by
// ALCHEMY_CHAINS). So these two functions are deliberately NOT gated on
// BLOCKSCOUT_CHAINS — they're called for any resolved chain, and a chain PRO
// doesn't cover just comes back 404 → null, same as any other miss.
const PRO_API_BASE = "https://api.blockscout.com";

interface BsSummaryVar {
  type: string;
  value: unknown;
}

interface BsSummaryResponse {
  success?: boolean;
  data?: {
    summaries?: { summary_template: string; summary_template_variables: Record<string, BsSummaryVar> }[];
  };
}

// Stringification of a template variable — verified live against a real
// native-transfer summary: "address" values are an object with a `hash` field
// (`{ens_domain_name, hash, is_contract, ...}`), which this falls through to.
// "token" values are still unverified (no live example produced one); falls
// through the same symbol/name/hash chain rather than leaking a raw object.
function stringifySummaryVar(v: BsSummaryVar): string {
  const val = v.value;
  if (val == null) return "";
  if (typeof val === "string" || typeof val === "number") return String(val);
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    if (typeof obj.symbol === "string") return obj.symbol;
    if (typeof obj.name === "string") return obj.name;
    if (typeof obj.hash === "string") return obj.hash;
  }
  return "";
}

// Verified live: a plain native transfer's template was
// "{action_type} {amount} {native} to {to_address}" — but
// summary_template_variables had no "native" entry at all. It's an implicit
// placeholder for the chain's own native currency symbol, not a variable
// Blockscout provides — the caller already knows it, so it's passed in rather
// than guessed.
function renderSummaryTemplate(template: string, vars: Record<string, BsSummaryVar>, nativeSymbol: string): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    if (key === "native") return nativeSymbol;
    return vars[key] ? stringifySummaryVar(vars[key]) : "";
  });
}

// Grounded in Blockscout's own decoded trace (internal transactions, token
// transfers, decoded calldata) rather than guessed from the sparse metadata
// lib/parseIntent.ts's generateTxSummary() works from — a paid/credit-metered
// PRO API feature, so an unset key returns null without attempting the call.
export async function getBlockscoutTxSummary(txHash: string, chainId: number, nativeSymbol = "ETH"): Promise<string | null> {
  if (!API_KEY) return null;
  try {
    const res = await fetchWithTimeout(
      withKey(`${PRO_API_BASE}/${chainId}/api/v2/transactions/${txHash}/summary`),
    );
    if (!res.ok) return null;
    const json = (await res.json()) as BsSummaryResponse;
    const first = json.data?.summaries?.[0];
    if (!first) return null;
    const rendered = renderSummaryTemplate(first.summary_template, first.summary_template_variables ?? {}, nativeSymbol);
    return rendered.trim() || null;
  } catch {
    return null;
  }
}

interface BsReputationResponse {
  addresses?: Record<string, { score: number }>;
}

interface BsMetadataResponse {
  addresses?: Record<string, { tags?: { name: string; slug: string; tagType: string }[] }>;
}

// The bare reputation score ("42") is uninterpretable alone, so this also
// pulls the sibling /metadata endpoint (public tags: "Scammer", "CEX Hot
// Wallet", etc.) and merges both into one "who is this wallet" answer.
// Response objects are keyed by address, but Blockscout's casing of that key
// isn't guaranteed to match what was requested — reads the first (and only,
// since exactly one address is queried) value instead of indexing by string
// to avoid a checksum-mismatch miss. chainId is intentionally not passed to
// /metadata — per Blockscout's docs, omitting it returns multichain-only
// tags, the right scope for an address that may be active on several of the
// chains Skopos tracks.
export async function getBlockscoutAddressReputation(address: string): Promise<AddressReputation | null> {
  if (!API_KEY) return null;
  try {
    const [repRes, metaRes] = await Promise.all([
      fetchWithTimeout(withKey(`${PRO_API_BASE}/services/metadata/api/v1/reputation?addresses=${address}`)),
      fetchWithTimeout(withKey(`${PRO_API_BASE}/services/metadata/api/v1/metadata?addresses=${address}`)),
    ]);
    const repJson: BsReputationResponse = repRes.ok ? await repRes.json() : {};
    const metaJson: BsMetadataResponse = metaRes.ok ? await metaRes.json() : {};
    const score = repJson.addresses ? Object.values(repJson.addresses)[0]?.score ?? null : null;
    const tags = metaJson.addresses ? Object.values(metaJson.addresses)[0]?.tags ?? [] : [];
    if (score == null && tags.length === 0) return null;
    return { score, tags };
  } catch {
    return null;
  }
}
