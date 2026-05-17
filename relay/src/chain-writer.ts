import { GearApi, GearKeyring } from "@gear-js/api";
import { Keyring } from "@polkadot/keyring";
import type { KeyringPair } from "@polkadot/keyring/types";
import { readFileSync } from "node:fs";
import { config } from "./config.js";
import type { BridgeResult } from "./types.js";

async function loadRelayKeyring(): Promise<KeyringPair> {
  if (config.relayWalletJson) {
    const path = config.relayWalletJson.replace(/^~/, process.env.HOME ?? "");
    const json = JSON.parse(readFileSync(path, "utf8"));
    const kr = new Keyring({ type: "sr25519" });
    const pair = kr.addFromJson(json);
    pair.unlock("");
    return pair;
  }
  return GearKeyring.fromMnemonic(config.relayMnemonic);
}

// Sails 1.0.0-beta.5 binary message header constants for BridgeService.
// INTERFACE_ID = first 8 bytes of keccak256 of (all method hashes + BridgeEvent hash).
// Computed by scripts/compute-interface-id.ts — includes all 9 exported methods.
// Methods sorted alphabetically by lowercase route name (sails-macros-core):
//   FeePlanks=0, FulfillRequest=1, NextId=2, QueryPending=3, Relay=4,
//   RequestData=5, SetFee=6, SetRelay=7, Withdraw=8
// Events sorted alphabetically: RequestFulfilled=0, RequestPending=1
const INTERFACE_ID = Uint8Array.from([0x55, 0xc1, 0x09, 0xcd, 0x00, 0x59, 0xcf, 0x2c]);
const FULFILL_REQUEST_ENTRY_ID = 1;  // alphabetical index among 9 methods
const QUERY_PENDING_ENTRY_ID   = 3;  // alphabetical index among 9 methods
const BRIDGE_ROUTE_IDX = 1;          // route IDs start at 1 (sails-idl-meta)

export async function fulfillRequest(
  api: GearApi,
  bridgeProgramId: string,
  requestId: bigint,
  result: BridgeResult,
): Promise<void> {
  const keyring = await loadRelayKeyring();
  const resultJson = JSON.stringify(result);
  const payload = encodeFulfillRequest(requestId, resultJson);

  await new Promise<void>((resolve, reject) => {
    api.message
      .send({
        destination: bridgeProgramId as `0x${string}`,
        payload,
        gasLimit: 10_000_000_000n,
        value: 0n,
      })
      .signAndSend(keyring, ({ status }) => {
        if (status.isInBlock) {
          console.log(`[chain-writer] fulfill_request ${requestId} included in block`);
          resolve();
        }
        if (status.isDropped || status.isInvalid) {
          reject(new Error(`extrinsic dropped/invalid for request ${requestId}`));
        }
      })
      .catch(reject);
  });
}

/**
 * Check whether a request is still pending on-chain before re-submitting after crash recovery.
 * Returns true  = still pending (safe to submit fulfill_request).
 * Returns false = already fulfilled (skip to avoid double-spend of gas).
 * Fails open: if the RPC call errors, returns true so the relay retries.
 *
 * Calls query_pending(id: u64) → Option<String> via calculateReply.
 * Reply payload (after 16-byte Sails header): 0x00 = None, 0x01 = Some.
 */
export async function queryPending(
  api: GearApi,
  bridgeProgramId: string,
  requestId: bigint,
): Promise<boolean> {
  const payload = encodeQueryPending(requestId);
  try {
    const keyring = await loadRelayKeyring();
    const reply = await api.message.calculateReply({
      destination: bridgeProgramId as `0x${string}`,
      origin: keyring.address as `0x${string}`,
      payload: Array.from(payload),
      gasLimit: 1_000_000_000n,
      value: 0n,
    });
    const bytes = reply.payload.toU8a();
    // Sails reply payload: 16-byte header (0x47 0x4d ...) + SCALE Option<String>.
    // Skip header if present; byte at offset is 0x00 (None = fulfilled) or 0x01 (Some = pending).
    const offset = bytes.length > 16 && bytes[0] === 0x47 && bytes[1] === 0x4d ? 16 : 0;
    return bytes[offset] === 0x01;
  } catch (err) {
    console.warn(`[chain-writer] queryPending(${requestId}) failed, assuming pending:`, err);
    return true; // fail-open: attempt fulfill_request rather than silently skip
  }
}

function encodeQueryPending(id: bigint): Uint8Array {
  const header = sailsHeader(QUERY_PENDING_ENTRY_ID, BRIDGE_ROUTE_IDX);
  const idBytes = new Uint8Array(8);
  new DataView(idBytes.buffer).setBigUint64(0, id, true);
  return concat(header, idBytes);
}

// Encodes fulfill_request(id: u64, result: String) using the Sails binary protocol.
// Payload: [16-byte SailsMessageHeader][u64 LE id][SCALE String result]
function encodeFulfillRequest(id: bigint, result: string): Uint8Array {
  const header = sailsHeader(FULFILL_REQUEST_ENTRY_ID, BRIDGE_ROUTE_IDX);

  const idBytes = new Uint8Array(8);
  new DataView(idBytes.buffer).setBigUint64(0, id, true);

  const resultBytes = new TextEncoder().encode(result);
  const resultLen = scaleCompact(resultBytes.length);

  return concat(header, idBytes, resultLen, resultBytes);
}

function sailsHeader(entryId: number, routeIdx: number): Uint8Array {
  const h = new Uint8Array(16);
  h[0] = 0x47; // 'G'
  h[1] = 0x4d; // 'M'
  h[2] = 0x01; // version
  h[3] = 0x10; // header_len = 16
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
