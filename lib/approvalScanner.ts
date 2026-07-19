import { fetchWithTimeout } from "./http";
import { ALCHEMY_CHAINS } from "./alchemy";
import { UNLIMITED_APPROVAL_MIN } from "./evmTx";

// Approval(address indexed owner, address indexed spender, uint256 value) —
// keccak256("Approval(address,address,uint256)"), verified via viem's
// keccak256(toBytes(...)) against the exact same signature.
const APPROVAL_TOPIC0 = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

// allowance(address,address) selector — keccak256("allowance(address,address)"),
// same verification method. Standard eth_call, works on any EVM RPC (unlike
// Alchemy's alchemy_getTokenAllowance convenience wrapper, which only exists
// on Alchemy's own node — 3 of these 10 chains use a public RPC instead).
const ALLOWANCE_SELECTOR = "0xdd62ed3e";

// Target scan window. A full-lifetime scan has no realistic path within a
// single chat response (Ethereum mainnet alone is ~23M blocks), so 90 days is
// the deliberate scope tradeoff. But most EVM providers — confirmed live
// against Base's own public RPC, and matching Alchemy's documented guidance
// for tiers below "unlimited" — cap a single eth_getLogs call to roughly
// 10,000 blocks. On fast chains (Arbitrum's ~0.25s blocks put 90 days at
// ~31M blocks) that single-call window can't be fetched in one request.
// fetchApprovalLogs() tries the wide call first and falls back to bounded
// chunked pagination when it's rejected; scanApprovals() reports the actual
// worst-case coverage achieved rather than silently overclaiming 90 days on
// chains where the fallback couldn't walk all the way back.
const SCAN_WINDOW_DAYS = 90;

// Rough average block time per chain, used only to convert the day-based
// window into a block count — approximate by design, not meant to be exact.
const AVG_BLOCK_TIME_SEC: Record<number, number> = {
  1: 12, 8453: 2, 42161: 0.25, 10: 2, 137: 2, 56: 3, 43114: 2, 324: 1, 59144: 3, 100: 5,
};

// Caps candidate (token, spender) pairs checked per chain — a wallet with an
// unusually long approval history shouldn't turn one scan into dozens of
// eth_call round-trips. 40 comfortably covers realistic wallets; anything
// beyond that is capped rather than left unbounded.
const MAX_PAIRS_PER_CHAIN = 40;

// Chunked-fallback tuning: per-call range cap (matches the ~10k limit
// observed in practice) and the max number of chunks walked backward from
// the latest block — bounds one chain's scan to at most this many sequential
// eth_getLogs calls regardless of how far behind the target fromBlock sits.
const CHUNK_BLOCKS = 10_000;
const MAX_CHUNKS = 12;

export interface ApprovalRow {
  chainId: number;
  chainName: string;
  tokenAddress: string;
  tokenSymbol: string;
  spender: string;
  allowanceRaw: string;
  unlimited: boolean;
  allowanceDisplay: string;
}

export interface ApprovalScanOutcome {
  rows: ApprovalRow[];
  windowDays: number;
}

async function rpcCall<T>(url: string, method: string, params: unknown[]): Promise<T> {
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

function padAddress(address: string): string {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

interface RawLog {
  address: string;
  topics: string[];
}

// Fetches Approval logs for `address` between fromBlock and latest. Tries a
// single wide call first (fine on providers that allow it); if that's
// rejected — the common case for fast chains and public RPCs — falls back to
// walking backward from `latest` in CHUNK_BLOCKS-sized calls, stopping at
// MAX_CHUNKS or once `fromBlock` is reached, whichever comes first. Returns
// the logs found plus the earliest block actually covered, since a capped
// fallback may not reach all the way back to `fromBlock`.
async function fetchApprovalLogs(
  rpc: string, address: string, fromBlock: number, latest: number
): Promise<{ logs: RawLog[]; earliestBlockCovered: number }> {
  const topics = [APPROVAL_TOPIC0, `0x${padAddress(address)}`];

  try {
    const logs = await rpcCall<RawLog[]>(rpc, "eth_getLogs", [{
      fromBlock: `0x${fromBlock.toString(16)}`, toBlock: "latest", topics,
    }]);
    return { logs, earliestBlockCovered: fromBlock };
  } catch {
    // Wide call rejected (range-limit error) — fall through to chunking.
  }

  const logs: RawLog[] = [];
  let cursor = latest;
  let earliestBlockCovered = latest;
  for (let i = 0; i < MAX_CHUNKS && cursor > fromBlock; i++) {
    const chunkFrom = Math.max(fromBlock, cursor - CHUNK_BLOCKS);
    try {
      const chunkLogs = await rpcCall<RawLog[]>(rpc, "eth_getLogs", [{
        fromBlock: `0x${chunkFrom.toString(16)}`, toBlock: `0x${cursor.toString(16)}`, topics,
      }]);
      logs.push(...chunkLogs);
      earliestBlockCovered = chunkFrom;
    } catch {
      // This chunk failed (rate limit, transient error) — stop walking
      // further back rather than claiming coverage we didn't actually scan.
      break;
    }
    cursor = chunkFrom - 1;
  }
  return { logs, earliestBlockCovered };
}

interface ChainScanResult {
  rows: ApprovalRow[];
  daysCovered: number;
}

async function scanChain(address: string, chainId: number): Promise<ChainScanResult> {
  const chain = ALCHEMY_CHAINS[chainId];
  if (!chain) return { rows: [], daysCovered: SCAN_WINDOW_DAYS };
  const blockTime = AVG_BLOCK_TIME_SEC[chainId] ?? 12;

  try {
    const latestHex = await rpcCall<string>(chain.rpc, "eth_blockNumber", []);
    const latest = parseInt(latestHex, 16);
    const windowBlocks = Math.floor((SCAN_WINDOW_DAYS * 86400) / blockTime);
    const fromBlock = Math.max(0, latest - windowBlocks);

    const { logs, earliestBlockCovered } = await fetchApprovalLogs(chain.rpc, address, fromBlock, latest);
    const daysCovered = Math.min(SCAN_WINDOW_DAYS, ((latest - earliestBlockCovered) * blockTime) / 86400);

    // Dedupe (token, spender) — the same pair can appear many times across
    // the window (re-approved, re-revoked); only the current on-chain
    // allowance matters, not how many times it changed getting there.
    const pairs = new Map<string, { token: string; spender: string }>();
    for (const log of logs) {
      if (!log.topics[2]) continue;
      const token = log.address.toLowerCase();
      const spender = `0x${log.topics[2].slice(-40)}`;
      pairs.set(`${token}:${spender}`, { token, spender });
    }
    if (pairs.size === 0) return { rows: [], daysCovered };

    // Current allowance per candidate pair — an Approval event only proves
    // an approval was SET at some block, not that it's still live. A pair
    // whose allowance is now 0 has been revoked or fully spent since, and is
    // dropped rather than shown as a stale, no-longer-real risk.
    const candidates = [...pairs.values()].slice(0, MAX_PAIRS_PER_CHAIN);
    const results = await Promise.allSettled(
      candidates.map(async ({ token, spender }) => {
        const calldata = `${ALLOWANCE_SELECTOR}${padAddress(address)}${padAddress(spender)}`;
        const allowanceHex = await rpcCall<string>(chain.rpc, "eth_call", [{ to: token, data: calldata }, "latest"]);
        const allowanceRaw = allowanceHex && allowanceHex !== "0x" ? BigInt(allowanceHex) : BigInt(0);
        if (allowanceRaw === BigInt(0)) return null;

        // alchemy_getTokenMetadata only resolves on chains actually running
        // Alchemy's node (alchemyErc20: true) — the other 3 fall back to a
        // shortened token address rather than a symbol, same degrade pattern
        // used elsewhere in lib/alchemy.ts.
        const metadata = chain.alchemyErc20
          ? await rpcCall<{ decimals?: number; symbol?: string }>(chain.rpc, "alchemy_getTokenMetadata", [token]).catch(() => null)
          : null;
        const decimals = metadata?.decimals ?? 18;
        const symbol = metadata?.symbol ?? `${token.slice(0, 6)}…${token.slice(-4)}`;

        const unlimited = allowanceRaw >= UNLIMITED_APPROVAL_MIN;
        const divisor = BigInt(10) ** BigInt(decimals);
        const allowanceDisplay = unlimited
          ? "unlimited"
          : (Number(allowanceRaw) / Number(divisor)).toLocaleString(undefined, { maximumFractionDigits: 2 });

        return {
          chainId, chainName: chain.name,
          tokenAddress: token, tokenSymbol: symbol,
          spender, allowanceRaw: allowanceRaw.toString(), unlimited, allowanceDisplay,
        } satisfies ApprovalRow;
      })
    );

    const rows = results.flatMap(r => r.status === "fulfilled" && r.value ? [r.value] : []);
    return { rows, daysCovered };
  } catch {
    // This chain's scan failed entirely (RPC down, etc.) — don't fail the
    // whole multi-chain scan over one chain's error. No rows came from it, so
    // it shouldn't drag down the reported window either.
    return { rows: [], daysCovered: SCAN_WINDOW_DAYS };
  }
}

// Scans up to the last 90 days of Approval events across every ALCHEMY_CHAINS
// chain in parallel, resolves each surviving (token, spender) pair to its
// CURRENT allowance, and returns unlimited approvals first. `windowDays`
// reports the worst-case (minimum) coverage actually achieved across chains
// that returned data — on fast or public-RPC chains where the chunked
// fallback engaged, this can be less than 90.
export async function scanApprovals(address: string): Promise<ApprovalScanOutcome> {
  const results = await Promise.allSettled(
    Object.keys(ALCHEMY_CHAINS).map(id => scanChain(address, Number(id)))
  );
  const fulfilled = results.flatMap(r => r.status === "fulfilled" ? [r.value] : []);
  const rows = fulfilled.flatMap(r => r.rows).sort((a, b) => Number(b.unlimited) - Number(a.unlimited));
  const windowDays = fulfilled.length
    ? Math.max(1, Math.floor(Math.min(...fulfilled.map(r => r.daysCovered))))
    : SCAN_WINDOW_DAYS;
  return { rows, windowDays };
}
