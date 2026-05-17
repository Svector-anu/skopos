import { hexToU8a } from "@polkadot/util";
import type { BridgePayload, RequestPendingEvent } from "./types.js";

// Sails 1.0.0-beta.5 event payload format for BridgeService.RequestPending:
//   [16-byte SailsMessageHeader][u64 LE id][ActorId 32 bytes][SCALE String payload]
//
// The SailsMessageHeader:
//   [0x47, 0x4D][version=1][hlen=16][INTERFACE_ID:8][entry_id:u16LE][route_idx:u8][reserved=0]
//
// INTERFACE_ID = 55c109cd0059cf2c (all 9 methods in alphabetical order)
// #[event] macro sorts variants alphabetically: RequestFulfilled=0, RequestPending=1
// Service methods (9 total) sorted alphabetically by lowercase route:
//   FeePlanks=0, FulfillRequest=1, NextId=2, QueryPending=3, Relay=4,
//   RequestData=5, SetFee=6, SetRelay=7, Withdraw=8

const GM_MAGIC = [0x47, 0x4d];
const INTERFACE_ID = Uint8Array.from([0x55, 0xc1, 0x09, 0xcd, 0x00, 0x59, 0xcf, 0x2c]);
const REQUEST_PENDING_ENTRY_ID = 1; // alphabetical: RequestFulfilled=0, RequestPending=1
const BRIDGE_ROUTE_IDX = 1;
const HEADER_LEN = 16;

export function decodeRequestPending(hexPayload: string): RequestPendingEvent | null {
  try {
    const bytes = hexToU8a(hexPayload);

    if (bytes.length < HEADER_LEN + 8 + 32 + 1) return null;

    // Validate GM magic bytes
    if (bytes[0] !== GM_MAGIC[0] || bytes[1] !== GM_MAGIC[1]) return null;

    // Validate interface_id at bytes 4..12
    for (let i = 0; i < 8; i++) {
      if (bytes[4 + i] !== INTERFACE_ID[i]) return null;
    }

    // Validate entry_id (bytes 12..14 LE) == 0 (RequestPending)
    const entryId = bytes[12] | (bytes[13] << 8);
    if (entryId !== REQUEST_PENDING_ENTRY_ID) return null;

    // Validate route_idx (byte 14) == 1
    if (bytes[14] !== BRIDGE_ROUTE_IDX) return null;

    // Decode body (starts at byte 16, variant index byte was skipped by sails emit_event)
    let offset = HEADER_LEN;

    // u64 LE id
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const id = view.getBigUint64(offset, true);
    offset += 8;

    // ActorId = 32 raw bytes
    const callerBytes = bytes.slice(offset, offset + 32);
    const caller = `0x${Buffer.from(callerBytes).toString("hex")}`;
    offset += 32;

    // SCALE String: compact length prefix + UTF-8 bytes
    const { value: payloadLen, bytesRead } = decodeScaleCompact(bytes, offset);
    offset += bytesRead;

    if (offset + payloadLen > bytes.length) return null;

    const payload = new TextDecoder().decode(bytes.slice(offset, offset + payloadLen));

    return { id, caller, payload };
  } catch {
    return null;
  }
}

export function parsePayload(raw: string): BridgePayload | null {
  try {
    const parsed = JSON.parse(raw) as BridgePayload;
    if (parsed.v !== "1" || !parsed.type || !parsed.params) return null;
    return parsed;
  } catch {
    return null;
  }
}

function decodeScaleCompact(bytes: Uint8Array, offset: number): { value: number; bytesRead: number } {
  const first = bytes[offset];
  const mode = first & 0x03;
  if (mode === 0) return { value: first >> 2, bytesRead: 1 };
  if (mode === 1) return { value: ((bytes[offset + 1] << 6) | (first >> 2)), bytesRead: 2 };
  if (mode === 2) {
    const v = first >>> 2 | (bytes[offset + 1] << 6) | (bytes[offset + 2] << 14) | (bytes[offset + 3] << 22);
    return { value: v, bytesRead: 4 };
  }
  throw new Error("SCALE big-int compact not supported");
}
