import { hexToU8a } from "@polkadot/util";
import type { BridgePayload, RequestPendingEvent } from "./types.js";

// Sails string-routing event payload format (current deployed oracle):
//   SCALE(service_name) + SCALE(event_name) + u64_LE(request_id) + SCALE(data_string)
//
// Observed on-chain example for request_id=257, service="SkoposOracle", event="RequestPending":
//   30 [SkoposOracle 12B] 38 [RequestPending 14B] [01 01 00 00 00 00 00 00] [c8 ...json 50B]
//
// Events are broadcast to destination=0x0000...0000 (zero address).
// The caller is not embedded in the payload; we use the oracle source address as placeholder.

const SERVICE_NAME = "SkoposOracle";
const EVENT_NAME = "RequestPending";

export function decodeRequestPending(hexPayload: string): RequestPendingEvent | null {
  try {
    const bytes = hexToU8a(hexPayload);
    let offset = 0;

    // SCALE string: service name
    const { value: svcLen, bytesRead: svcLenBytes } = decodeScaleCompact(bytes, offset);
    offset += svcLenBytes;
    if (offset + svcLen > bytes.length) return null;
    const svcName = new TextDecoder().decode(bytes.slice(offset, offset + svcLen));
    if (svcName !== SERVICE_NAME) return null;
    offset += svcLen;

    // SCALE string: event name
    const { value: evtLen, bytesRead: evtLenBytes } = decodeScaleCompact(bytes, offset);
    offset += evtLenBytes;
    if (offset + evtLen > bytes.length) return null;
    const evtName = new TextDecoder().decode(bytes.slice(offset, offset + evtLen));
    if (evtName !== EVENT_NAME) return null;
    offset += evtLen;

    // u64 LE: request_id
    if (offset + 8 > bytes.length) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const id = view.getBigUint64(offset, true);
    offset += 8;

    // SCALE string: JSON payload
    const { value: payloadLen, bytesRead: payloadLenBytes } = decodeScaleCompact(bytes, offset);
    offset += payloadLenBytes;
    if (offset + payloadLen > bytes.length) return null;
    const payload = new TextDecoder().decode(bytes.slice(offset, offset + payloadLen));

    // Caller is not embedded in the event payload in this Sails version.
    const caller = "0x" + "00".repeat(32);

    return { id, caller, payload };
  } catch {
    return null;
  }
}

const MAX_PAYLOAD_BYTES = 4096;

export function parsePayload(raw: string): BridgePayload | null {
  if (raw.length > MAX_PAYLOAD_BYTES) return null;
  try {
    const parsed = JSON.parse(raw) as BridgePayload;
    if (parsed.v !== "1" || !parsed.type || !parsed.params) return null;
    if (typeof parsed.params !== "object" || Array.isArray(parsed.params) || parsed.params === null) return null;
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
