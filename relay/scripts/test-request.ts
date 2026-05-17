/**
 * E2E test script — submits a price query to the bridge program and waits
 * for the relay to fulfill it. Run after gear --dev + bridge deployed + relay running.
 *
 * Usage:
 *   BRIDGE_PROGRAM_ID=0x... tsx scripts/test-request.ts
 */
import { GearApi, GearKeyring } from "@gear-js/api";
import { WsProvider } from "@polkadot/api";
import { u8aToHex } from "@polkadot/util";

const RPC_WS = process.env.VARA_RPC_WS ?? "ws://127.0.0.1:9944";
const BRIDGE_PROGRAM_ID = process.env.BRIDGE_PROGRAM_ID!;
if (!BRIDGE_PROGRAM_ID) throw new Error("BRIDGE_PROGRAM_ID required");

// Sails 1.0.0-beta.5 constants for BridgeService — all 9 methods included.
// Methods sorted alphabetically by lowercase route name:
//   FeePlanks=0, FulfillRequest=1, NextId=2, QueryPending=3, Relay=4,
//   RequestData=5, SetFee=6, SetRelay=7, Withdraw=8
// Events sorted alphabetically: RequestFulfilled=0, RequestPending=1
const INTERFACE_ID = Uint8Array.from([0x55, 0xc1, 0x09, 0xcd, 0x00, 0x59, 0xcf, 0x2c]);
const REQUEST_DATA_ENTRY_ID = 5; // alphabetical index among 9 methods
const BRIDGE_ROUTE_IDX = 1;     // route IDs start at 1 (sails-idl-meta)

const QUERY_PAYLOAD = JSON.stringify({
  v: "1",
  type: "price",
  params: { symbol: "ETH" },
});

async function main() {
  console.log(`[test] connecting to ${RPC_WS}`);
  const provider = new WsProvider(RPC_WS);
  const api = await GearApi.create({ provider });
  await api.isReady;
  console.log("[test] connected");

  const alice = await GearKeyring.fromMnemonic("//Alice");
  const aliceId = u8aToHex(alice.publicKey);
  console.log(`[test] caller (Alice): ${aliceId}`);

  const payload = encodeRequestData(QUERY_PAYLOAD);
  console.log("[test] sending request_data to bridge...");

  // Subscribe to UserMessageSent BEFORE sending, so we catch the reply even if it arrives
  // in a subsequent block (Gear processes queued messages in the following block).
  let requestId: bigint | null = null;
  const requestIdPromise = new Promise<bigint>((resolve) => {
    void api.gearEvents.subscribeToGearEvent("UserMessageSent", (event) => {
      const msg = event.data.message;
      if (msg.source.toHex() !== BRIDGE_PROGRAM_ID.toLowerCase()) return;
      if (msg.destination.toHex() !== aliceId) return;
      // Reply payload: [16-byte Sails header][0x00 = Result::Ok][u64 LE id]
      const bytes = Buffer.from(msg.payload.toHex().slice(2), "hex");
      if (bytes.length >= 16 + 1 + 8 && bytes[16] === 0x00) {
        requestId = bytes.readBigUInt64LE(17);
        console.log(`[test] got request_id = ${requestId}`);
        resolve(requestId);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    api.message
      .send({
        destination: BRIDGE_PROGRAM_ID as `0x${string}`,
        payload,
        gasLimit: 10_000_000_000n,
        value: 0n,
      })
      .signAndSend(alice, ({ status }) => {
        if (status.isInBlock) {
          console.log(`[test] request_data included in block`);
          resolve();
        }
        if (status.isDropped || status.isInvalid) {
          reject(new Error("extrinsic dropped/invalid"));
        }
      })
      .catch(reject);
  });

  const replyTimeout = setTimeout(() => {
    console.error("[test] TIMEOUT — no reply from bridge within 30s");
    void api.disconnect();
    process.exit(1);
  }, 30_000);

  requestId = await requestIdPromise;
  clearTimeout(replyTimeout);

  const timeout = setTimeout(() => {
    console.error("[test] TIMEOUT — relay did not fulfill within 60s");
    void api.disconnect();
    process.exit(1);
  }, 60_000);

  await new Promise<void>((resolve) => {
    void api.gearEvents.subscribeToGearEvent("UserMessageSent", (event) => {
      const msg = event.data.message;
      if (msg.destination.toHex() !== aliceId) return;
      const bytes = Buffer.from(msg.payload.toHex().slice(2), "hex");
      // Skip Sails protocol messages (GM magic = 0x47 0x4D)
      if (bytes[0] === 0x47 && bytes[1] === 0x4d) return;
      // Only accept JSON payloads
      if (bytes[0] !== 0x7b) return; // '{'
      clearTimeout(timeout);
      console.log("\n[test] ✅ RESULT RECEIVED:");
      console.log(bytes.toString("utf8"));
      resolve();
    });
  });

  await api.disconnect();
  console.log("[test] done");
}

// Encodes request_data(payload: String) using the Sails binary protocol.
// Payload: [16-byte SailsMessageHeader][SCALE String payload]
function encodeRequestData(payload: string): Uint8Array {
  const header = sailsHeader(REQUEST_DATA_ENTRY_ID, BRIDGE_ROUTE_IDX);
  const payloadBytes = new TextEncoder().encode(payload);
  const payloadLen = scaleCompact(payloadBytes.length);
  return concat(header, payloadLen, payloadBytes);
}

function sailsHeader(entryId: number, routeIdx: number): Uint8Array {
  const h = new Uint8Array(16);
  h[0] = 0x47; h[1] = 0x4d; // GM magic
  h[2] = 0x01; h[3] = 0x10; // version=1, header_len=16
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
  console.error("[test] error:", err);
  process.exit(1);
});
