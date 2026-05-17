// Constructs a valid RequestPending event hex payload for testing event-parser.
// Mirrors the encoding in sails-rs emit_event + Sails binary header spec.

const INTERFACE_ID = Uint8Array.from([0x55, 0xa7, 0x12, 0x41, 0x6e, 0x41, 0xaf, 0x40]);
const REQUEST_PENDING_ENTRY_ID = 1;
const BRIDGE_ROUTE_IDX = 1;

// Alice's public key (sr25519 dev account)
const ALICE = Uint8Array.from(
  "d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d"
    .match(/.{2}/g)!
    .map((b) => parseInt(b, 16)),
);

export interface RequestPendingOptions {
  id?: bigint;
  caller?: Uint8Array;
  payload?: string;
  entryId?: number;
  routeIdx?: number;
  interfaceId?: Uint8Array;
}

export function buildRequestPendingHex(opts: RequestPendingOptions = {}): string {
  const {
    id = 1n,
    caller = ALICE,
    payload = '{"v":"1","type":"price","params":{"symbol":"ETH"}}',
    entryId = REQUEST_PENDING_ENTRY_ID,
    routeIdx = BRIDGE_ROUTE_IDX,
    interfaceId = INTERFACE_ID,
  } = opts;

  // 16-byte Sails message header
  const header = new Uint8Array(16);
  header[0] = 0x47; header[1] = 0x4d; // GM magic
  header[2] = 0x01;                    // version
  header[3] = 0x10;                    // header_len = 16
  header.set(interfaceId, 4);
  new DataView(header.buffer).setUint16(12, entryId, true);
  header[14] = routeIdx;
  header[15] = 0x00;

  // u64 LE id
  const idBytes = new Uint8Array(8);
  new DataView(idBytes.buffer).setBigUint64(0, id, true);

  // ActorId (32 bytes)
  const callerBytes = caller.slice(0, 32);

  // SCALE compact-prefixed UTF-8 string
  const payloadBytes = new TextEncoder().encode(payload);
  const lenPrefix = scaleCompact(payloadBytes.length);

  const all = [header, idBytes, callerBytes, lenPrefix, payloadBytes];
  const total = all.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of all) { out.set(a, off); off += a.length; }

  return "0x" + Buffer.from(out).toString("hex");
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
