/**
 * Computes the BridgeService INTERFACE_ID using the exact algorithm from
 * sails-idl-ast-1.0.0-beta.5/src/hash.rs and sails-macros-core-1.0.0-beta.5.
 *
 * Rules confirmed from Sails source:
 *   1. All service methods sorted by f.route.to_lowercase()
 *   2. Event variants sorted by v.ident.to_string().to_lowercase()
 *   3. fn_hash = keccak("command"|"query" || name || arg_type_hashes... || "res" || output_hash)
 *   4. Type hashes: keccak(primitive.as_str()) for primitives
 *   5. INTERFACE_ID = keccak(fn_hash_0 || ... || fn_hash_N || ev_hash)[0..8]
 *
 * BridgeService exported methods (sorted by lowercase route):
 *   feeplanks   (FeePlanks)     entry_id 0 — query()    -> u128
 *   fulfillrequest (FulfillRequest) entry_id 1 — command(id: u64, result: String) -> Result<(), String>
 *   nextid      (NextId)        entry_id 2 — query()    -> u64
 *   querypending (QueryPending)  entry_id 3 — query(id: u64) -> Option<String>
 *   relay       (Relay)         entry_id 4 — query()    -> ActorId
 *   requestdata (RequestData)   entry_id 5 — command(payload: String) -> Result<u64, String>
 *   setfee      (SetFee)        entry_id 6 — command(fee: u128) -> Result<(), String>
 *   setrelay    (SetRelay)      entry_id 7 — command(new_relay: ActorId) -> Result<(), String>
 *   withdraw    (Withdraw)      entry_id 8 — command(amount: u128) -> Result<(), String>
 *
 * BridgeEvent variants (sorted by lowercase):
 *   requestfulfilled (RequestFulfilled) index 0 — { id: u64 }
 *   requestpending   (RequestPending)   index 1 — { id: u64, caller: ActorId, payload: String }
 */

import { keccak256AsU8a } from "@polkadot/util-crypto";

function keccak(data: Uint8Array): Uint8Array {
  return keccak256AsU8a(data);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const enc = new TextEncoder();
const t = (s: string) => enc.encode(s);

// ── Primitive hashes (PrimitiveType::as_str() from sails-idl-ast) ────────────
const HASH_void    = keccak(t("()"));    // Rust ()
const HASH_u64     = keccak(t("u64"));
const HASH_u128    = keccak(t("u128"));
const HASH_String  = keccak(t("String"));
const HASH_ActorId = keccak(t("ActorId"));

// ── Derived type hashes ───────────────────────────────────────────────────────
const HASH_Result_u64_String   = keccak(concat(t("Result"), HASH_u64,  HASH_String));
const HASH_Result_void_String  = keccak(concat(t("Result"), HASH_void, HASH_String));
const HASH_Option_String       = keccak(concat(t("Option"), HASH_String));

// ── fn_hash(kind, PascalCaseName, arg_hashes..., output_hash) ────────────────
function fnHash(kind: "command" | "query", name: string, args: Uint8Array[], result: Uint8Array): Uint8Array {
  return keccak(concat(t(kind), t(name), ...args, t("res"), result));
}

// Methods in alphabetical order by lowercase route (sails-macros-core sort):
const FN_fee_planks    = fnHash("query",   "FeePlanks",     [],              HASH_u128);
const FN_fulfill_req   = fnHash("command", "FulfillRequest",[HASH_u64, HASH_String], HASH_Result_void_String);
const FN_next_id       = fnHash("query",   "NextId",         [],              HASH_u64);
const FN_query_pending = fnHash("query",   "QueryPending",   [HASH_u64],      HASH_Option_String);
const FN_relay         = fnHash("query",   "Relay",           [],              HASH_ActorId);
const FN_request_data  = fnHash("command", "RequestData",    [HASH_String],   HASH_Result_u64_String);
const FN_set_fee       = fnHash("command", "SetFee",          [HASH_u128],     HASH_Result_void_String);
const FN_set_relay     = fnHash("command", "SetRelay",        [HASH_ActorId],  HASH_Result_void_String);
const FN_withdraw      = fnHash("command", "Withdraw",        [HASH_u128],     HASH_Result_void_String);

// ── BridgeEvent hash (alphabetical: RequestFulfilled=0, RequestPending=1) ────
const EV_RequestFulfilled = keccak(concat(t("RequestFulfilled"), HASH_u64));
const EV_RequestPending   = keccak(concat(t("RequestPending"),   HASH_u64, HASH_ActorId, HASH_String));
const HASH_BridgeEvent    = keccak(concat(EV_RequestFulfilled, EV_RequestPending));

// ── INTERFACE_ID = keccak(fn_hashes... || event_hash)[0..8] ──────────────────
const interfaceIdFull = keccak(concat(
  FN_fee_planks,
  FN_fulfill_req,
  FN_next_id,
  FN_query_pending,
  FN_relay,
  FN_request_data,
  FN_set_fee,
  FN_set_relay,
  FN_withdraw,
  HASH_BridgeEvent,
));

const INTERFACE_ID = interfaceIdFull.slice(0, 8);

console.log("INTERFACE_ID (8 bytes):");
console.log("  hex:", Buffer.from(INTERFACE_ID).toString("hex"));
console.log("  array:", Array.from(INTERFACE_ID).map(b => `0x${b.toString(16).padStart(2, "0")}`).join(", "));
console.log();
console.log("Entry IDs (sorted by lowercase route):");

const ENTRIES = [
  ["fee_planks",     "FeePlanks",      0, "query",   "() -> u128"],
  ["fulfill_request","FulfillRequest", 1, "command", "(id: u64, result: String) -> Result<(), String>"],
  ["next_id",        "NextId",         2, "query",   "() -> u64"],
  ["query_pending",  "QueryPending",   3, "query",   "(id: u64) -> Option<String>"],
  ["relay",          "Relay",          4, "query",   "() -> ActorId"],
  ["request_data",   "RequestData",    5, "command", "(payload: String) -> Result<u64, String>"],
  ["set_fee",        "SetFee",         6, "command", "(fee: u128) -> Result<(), String>"],
  ["set_relay",      "SetRelay",       7, "command", "(new_relay: ActorId) -> Result<(), String>"],
  ["withdraw",       "Withdraw",       8, "command", "(amount: u128) -> Result<(), String>"],
] as const;

for (const [method, route, id, kind, sig] of ENTRIES) {
  console.log(`  ${method} (${route}) entry_id=${id} [${kind}] ${sig}`);
}

console.log();
console.log("Sample Sails 16-byte message headers:");
for (const [method, _route, entryId] of ENTRIES) {
  const h = new Uint8Array(16);
  h[0] = 0x47; h[1] = 0x4d; h[2] = 0x01; h[3] = 0x10;
  h.set(INTERFACE_ID, 4);
  new DataView(h.buffer).setUint16(12, entryId as number, true);
  h[14] = 0x00; // route_idx to be determined by testing
  h[15] = 0x00;
  console.log(`  ${method} (entry_id=${entryId}): 0x${Buffer.from(h).toString("hex")}`);
}

console.log();
console.log("BridgeEvent indices (alphabetical):");
console.log("  RequestFulfilled: 0");
console.log("  RequestPending:   1");
