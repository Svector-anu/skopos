/**
 * Multi-query-type E2E test — exercises all 6 BridgePayload query types.
 *
 * Usage:
 *   BRIDGE_PROGRAM_ID=0x... QUERY_TYPE=risk tsx scripts/test-query-types.ts
 *
 * QUERY_TYPE: price | risk | yield | markets | quote | portfolio
 * If QUERY_TYPE is omitted, runs all types in sequence.
 *
 * Extra env vars for "quote":
 *   SENDER_ADDRESS   — EVM address (default: vitalik.eth)
 *   RECEIVER_ADDRESS — EVM address (default: same as sender)
 */
import { GearApi, GearKeyring } from "@gear-js/api";
import { WsProvider } from "@polkadot/api";
import { u8aToHex } from "@polkadot/util";

const RPC_WS = process.env.VARA_RPC_WS ?? "wss://testnet.vara.network";
const BRIDGE_PROGRAM_ID = process.env.BRIDGE_PROGRAM_ID!;
if (!BRIDGE_PROGRAM_ID) throw new Error("BRIDGE_PROGRAM_ID required");

const SENDER_ADDRESS = process.env.SENDER_ADDRESS ?? "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

const INTERFACE_ID = Uint8Array.from([0x55, 0xc1, 0x09, 0xcd, 0x00, 0x59, 0xcf, 0x2c]);
const REQUEST_DATA_ENTRY_ID = 5;
const BRIDGE_ROUTE_IDX = 1;

const PAYLOADS: Record<string, object> = {
  price: { v: "1", type: "price", params: { symbol: "BTC" } },
  risk: {
    v: "1",
    type: "risk",
    params: {
      // USDC on Ethereum — well-known token, good DexScreener coverage
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      chain: "ethereum",
    },
  },
  yield: { v: "1", type: "yield", params: { limit: 5 } },
  markets: { v: "1", type: "markets", params: { topic: "bitcoin", limit: 5 } },
  quote: {
    v: "1",
    type: "quote",
    params: {
      originChain: "ethereum",
      destinationChain: "base",
      token: "USDC",
      destinationToken: "USDC",
      amount: "1000000", // 1 USDC (6-decimal wei)
      senderAddress: SENDER_ADDRESS,
      receiverAddress: process.env.RECEIVER_ADDRESS ?? SENDER_ADDRESS,
    },
  },
  portfolio: { v: "1", type: "portfolio", params: { address: SENDER_ADDRESS } },
};

const ALL_TYPES = ["price", "risk", "yield", "markets", "quote", "portfolio"];

async function runOne(
  api: GearApi,
  alice: Awaited<ReturnType<typeof GearKeyring.fromMnemonic>>,
  aliceId: string,
  queryType: string,
  payload: object,
): Promise<boolean> {
  const payloadStr = JSON.stringify(payload);
  console.log(`\n${"─".repeat(60)}`);
  console.log(`[test] query type: ${queryType}`);
  console.log(`[test] payload: ${payloadStr}`);

  const encoded = encodeRequestData(payloadStr);

  // Set up BOTH subscriptions BEFORE sending — prevents missing the result
  // if the relay is fast and the result arrives before we subscribe.
  const done = new Promise<string>((resolve, reject) => {
    let requestId: bigint | null = null;

    const timeout = setTimeout(() => {
      reject(new Error("timeout after 120s"));
    }, 120_000);

    void api.gearEvents.subscribeToGearEvent("UserMessageSent", (event) => {
      const msg = event.data.message;
      const src = msg.source.toHex();
      const dst = msg.destination.toHex();

      // 1. Bridge → Alice: reply to request_data containing the request_id
      if (src === BRIDGE_PROGRAM_ID.toLowerCase() && dst === aliceId && requestId === null) {
        const bytes = Buffer.from(msg.payload.toHex().slice(2), "hex");
        if (bytes.length >= 17 + 8 && bytes[16] === 0x00) {
          requestId = bytes.readBigUInt64LE(17);
          console.log(`[test] request_id = ${requestId}`);
        }
        return;
      }

      // 2. Bridge → Alice: fulfill_request result (JSON payload)
      if (dst === aliceId && requestId !== null) {
        const bytes = Buffer.from(msg.payload.toHex().slice(2), "hex");
        if (bytes[0] === 0x47 && bytes[1] === 0x4d) return; // Sails protocol msg
        if (bytes[0] !== 0x7b) return; // must start with '{'
        clearTimeout(timeout);
        resolve(bytes.toString("utf8"));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    api.message
      .send({
        destination: BRIDGE_PROGRAM_ID as `0x${string}`,
        payload: encoded,
        gasLimit: 10_000_000_000n,
        value: 0n,
      })
      .signAndSend(alice, ({ status }) => {
        if (status.isInBlock) {
          console.log(`[test] request_data in block`);
          resolve();
        }
        if (status.isDropped || status.isInvalid) reject(new Error("extrinsic dropped/invalid"));
      })
      .catch(reject);
  });

  const result = await done;
  console.log(`[test] RESULT: ${result}`);

  const parsed = JSON.parse(result) as { ok?: boolean; error?: string };
  if (!parsed.ok) {
    console.error(`[test] ✗ FAIL — ok:false — ${parsed.error ?? "unknown"}`);
    return false;
  }
  console.log(`[test] ✓ PASS`);
  return true;
}

async function main() {
  console.log(`[test] connecting to ${RPC_WS}`);
  const provider = new WsProvider(RPC_WS);
  const api = await GearApi.create({ provider });
  await api.isReady;
  console.log("[test] connected");

  const alice = await GearKeyring.fromMnemonic("//Alice");
  const aliceId = u8aToHex(alice.publicKey);

  const requestedType = process.env.QUERY_TYPE;
  const types = requestedType ? [requestedType] : ALL_TYPES;

  const results: Record<string, boolean> = {};
  for (const qt of types) {
    const payload = PAYLOADS[qt];
    if (!payload) {
      console.error(`[test] unknown QUERY_TYPE: ${qt}`);
      results[qt] = false;
      continue;
    }
    try {
      results[qt] = await runOne(api, alice, aliceId, qt, payload);
    } catch (err) {
      console.error(`[test] ${qt} error:`, err);
      results[qt] = false;
    }
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log("[test] SUMMARY");
  for (const [qt, ok] of Object.entries(results)) {
    console.log(`  ${ok ? "✓" : "✗"} ${qt}`);
  }

  const allPassed = Object.values(results).every(Boolean);
  await api.disconnect();
  process.exit(allPassed ? 0 : 1);
}

function encodeRequestData(payload: string): Uint8Array {
  const header = sailsHeader(REQUEST_DATA_ENTRY_ID, BRIDGE_ROUTE_IDX);
  const payloadBytes = new TextEncoder().encode(payload);
  const payloadLen = scaleCompact(payloadBytes.length);
  return concat(header, payloadLen, payloadBytes);
}

function sailsHeader(entryId: number, routeIdx: number): Uint8Array {
  const h = new Uint8Array(16);
  h[0] = 0x47; h[1] = 0x4d;
  h[2] = 0x01; h[3] = 0x10;
  h.set(INTERFACE_ID, 4);
  new DataView(h.buffer).setUint16(12, entryId, true);
  h[14] = routeIdx;
  h[15] = 0x00;
  return h;
}

function scaleCompact(n: number): Uint8Array {
  if (n <= 63) return new Uint8Array([n << 2]);
  if (n <= 16383) {
    const v = (n << 2) | 1;
    return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  }
  const v = (n << 2) | 2;
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

main().catch((err) => {
  console.error("[test] fatal:", err);
  process.exit(1);
});
