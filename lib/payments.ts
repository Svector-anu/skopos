import { createPublicClient, http, isAddress, getAddress, formatUnits, keccak256, toHex } from "viem";
import { base, baseSepolia } from "viem/chains";

// Inbound B20 memo-payment reconciliation. Finds payments sent to an address that
// carried an on-chain memo (B20 transferWithMemo → Memo event), decodes the memo,
// and returns them newest-first — turning the one-way "pay" primitive into a
// two-sided, self-reconciling flow ("order-1024 paid").
//
// Public Base RPCs reject eth_getLogs without an address filter and cap the block
// range (~2k), so we scan a known set of B20 token addresses in bounded chunks.
// A production version would use an indexer for full history and any-token reach.

const CHAINS = { 8453: base, 84532: baseSepolia } as const;
type PayChainId = keyof typeof CHAINS;

const KNOWN_B20: Record<PayChainId, `0x${string}`[]> = {
  8453: [],
  84532: ["0xb200000000000000000000b4cd6Cd5af9e950652"], // MYT
};

const TRANSFER_TOPIC = keccak256(toHex("Transfer(address,address,uint256)"));
const MEMO_TOPIC = keccak256(toHex("Memo(address,bytes32)"));
const ZERO_MEMO = `0x${"0".repeat(64)}`;
const CHUNK = BigInt(2000);
const MAX_CHUNKS = 12;

const META_ABI = [
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

function makeClient(chainId: PayChainId) {
  return createPublicClient({ chain: CHAINS[chainId], transport: http() });
}
const clients = new Map<PayChainId, ReturnType<typeof makeClient>>();
function clientFor(chainId: PayChainId) {
  let c = clients.get(chainId);
  if (!c) { c = makeClient(chainId); clients.set(chainId, c); }
  return c;
}

function decodeMemo(b32: string): string {
  return Buffer.from(b32.slice(2), "hex").toString("utf8").replace(/[^\x20-\x7e]/g, "").trim();
}
function padAddr(a: string): string {
  return `0x${"0".repeat(24)}${a.toLowerCase().slice(2)}`;
}
function hex(n: bigint): string {
  return `0x${n.toString(16)}`;
}

const metaCache = new Map<string, { symbol: string; decimals: number }>();
async function tokenMeta(client: ReturnType<typeof makeClient>, token: `0x${string}`) {
  const key = token.toLowerCase();
  const hit = metaCache.get(key);
  if (hit) return hit;
  const [decimals, symbol] = await Promise.all([
    client.readContract({ address: token, abi: META_ABI, functionName: "decimals" }) as Promise<number>,
    client.readContract({ address: token, abi: META_ABI, functionName: "symbol" }) as Promise<string>,
  ]);
  const meta = { symbol, decimals };
  metaCache.set(key, meta);
  return meta;
}

type RawLog = { address: string; topics: string[]; data: string; transactionHash: `0x${string}`; blockNumber: string };
async function rawGetLogs(client: ReturnType<typeof makeClient>, params: Record<string, unknown>): Promise<RawLog[]> {
  return client.request({ method: "eth_getLogs", params: [params] } as never) as Promise<RawLog[]>;
}

export interface MemoPayment {
  chainId: number;
  chainName: string;
  token: `0x${string}`;
  tokenSymbol: string;
  amount: string;
  from: `0x${string}`;
  memo: string;
  memoText: string;
  txHash: `0x${string}`;
  timestamp: number | null;
}

export async function getMemoPayments(chainId: PayChainId, address: string, max = 25): Promise<MemoPayment[]> {
  if (!isAddress(address)) return [];
  const tokens = KNOWN_B20[chainId] ?? [];
  if (tokens.length === 0) return [];

  const client = clientFor(chainId);
  const toTopic = padAddr(address);
  const latest = await client.getBlockNumber();
  const found: (MemoPayment & { blockNumber: bigint })[] = [];

  for (const token of tokens) {
    for (let i = 0; i < MAX_CHUNKS && found.length < max; i++) {
      const toB = latest - BigInt(i) * CHUNK;
      const fromB = toB - CHUNK + BigInt(1);
      if (toB < BigInt(0)) break;

      let transfers: RawLog[];
      let memos: RawLog[];
      try {
        [transfers, memos] = await Promise.all([
          rawGetLogs(client, { address: token, topics: [TRANSFER_TOPIC, null, toTopic], fromBlock: hex(fromB < BigInt(0) ? BigInt(0) : fromB), toBlock: hex(toB) }),
          rawGetLogs(client, { address: token, topics: [MEMO_TOPIC], fromBlock: hex(fromB < BigInt(0) ? BigInt(0) : fromB), toBlock: hex(toB) }),
        ]);
      } catch {
        continue;
      }

      const memoByTx = new Map(memos.map(m => [m.transactionHash, m.topics[2]]));
      for (const t of transfers) {
        const memo = memoByTx.get(t.transactionHash);
        if (!memo || memo === ZERO_MEMO) continue;
        const meta = await tokenMeta(client, token);
        found.push({
          chainId,
          chainName: CHAINS[chainId].name,
          token,
          tokenSymbol: meta.symbol,
          amount: formatUnits(BigInt(t.data), meta.decimals),
          from: getAddress(`0x${t.topics[1].slice(26)}`),
          memo,
          memoText: decodeMemo(memo),
          txHash: t.transactionHash,
          timestamp: null,
          blockNumber: BigInt(t.blockNumber),
        });
      }
    }
  }

  // Fill timestamps for the unique blocks we kept.
  const uniqueBlocks = [...new Set(found.map(f => f.blockNumber))];
  const tsByBlock = new Map<bigint, number>();
  await Promise.all(uniqueBlocks.map(async bn => {
    try { tsByBlock.set(bn, Number((await client.getBlock({ blockNumber: bn })).timestamp)); } catch { /* leave null */ }
  }));

  return found
    .map(({ blockNumber, ...p }) => ({ ...p, timestamp: tsByBlock.get(blockNumber) ?? null }))
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
    .slice(0, max);
}
