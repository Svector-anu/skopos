// Constructs a valid RequestPending event hex payload for testing event-parser.
// Mirrors the Sails string-routing wire format (see src/event-parser.ts):
//   SCALE(service_name) + SCALE(event_name) + u64_LE(request_id) + SCALE(data_string)

const SERVICE_NAME = "SkoposOracle";
const EVENT_NAME = "RequestPending";

export interface RequestPendingOptions {
  id?: bigint;
  payload?: string;
  serviceName?: string;
  eventName?: string;
}

export function buildRequestPendingHex(opts: RequestPendingOptions = {}): string {
  const {
    id = 1n,
    payload = '{"v":"1","type":"price","params":{"symbol":"ETH"}}',
    serviceName = SERVICE_NAME,
    eventName = EVENT_NAME,
  } = opts;

  const svcBytes     = new TextEncoder().encode(serviceName);
  const evtBytes     = new TextEncoder().encode(eventName);
  const payloadBytes = new TextEncoder().encode(payload);

  // u64 LE id
  const idBytes = new Uint8Array(8);
  new DataView(idBytes.buffer).setBigUint64(0, id, true);

  const all = [
    scaleCompact(svcBytes.length), svcBytes,
    scaleCompact(evtBytes.length), evtBytes,
    idBytes,
    scaleCompact(payloadBytes.length), payloadBytes,
  ];
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
