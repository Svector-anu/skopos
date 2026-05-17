// Native binary that computes and prints the BridgeService INTERFACE_ID.
// Run with: cargo run --target $(rustup show active-toolchain | sed 's/-.*//') --bin print_interface_id
// Or: cargo build --target x86_64-apple-darwin --bin print_interface_id
//
// This must produce a result identical to the compile-time constant embedded in skopos_bridge.wasm.

use keccak_const::Keccak256;

fn keccak(data: &[u8]) -> [u8; 32] {
    Keccak256::new().update(data).finalize()
}

fn keccak_chain(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Keccak256::new();
    for part in parts {
        h = h.update(part);
    }
    h.finalize()
}

// ReflectHash for primitive types: keccak(type_name)
const HASH_U64: [u8; 32] = Keccak256::new().update(b"u64").finalize();
const HASH_STRING: [u8; 32] = Keccak256::new().update(b"String").finalize();
const HASH_UNIT: [u8; 32] = Keccak256::new().update(b"()").finalize();
const HASH_ACTOR_ID: [u8; 32] = Keccak256::new().update(b"ActorId").finalize();

// Result<u64, String>::HASH = keccak("Result" || u64::HASH || String::HASH)
const HASH_RESULT_U64_STRING: [u8; 32] = Keccak256::new()
    .update(b"Result")
    .update(&HASH_U64)
    .update(&HASH_STRING)
    .finalize();

// Result<(), String>::HASH = keccak("Result" || ()::HASH || String::HASH)
const HASH_RESULT_UNIT_STRING: [u8; 32] = Keccak256::new()
    .update(b"Result")
    .update(&HASH_UNIT)
    .update(&HASH_STRING)
    .finalize();

// Option<String>::HASH = keccak("Option" || String::HASH)
const HASH_OPTION_STRING: [u8; 32] = Keccak256::new()
    .update(b"Option")
    .update(&HASH_STRING)
    .finalize();

// BridgeEvent::HASH — enum derive:
//   variant_hash = keccak("VariantName" || field_hashes...)
//   enum_hash = keccak(variant_hash_0 || variant_hash_1)
const VARIANT_REQUEST_PENDING: [u8; 32] = Keccak256::new()
    .update(b"RequestPending")
    .update(&HASH_U64)
    .update(&HASH_ACTOR_ID)
    .update(&HASH_STRING)
    .finalize();

const VARIANT_REQUEST_FULFILLED: [u8; 32] = Keccak256::new()
    .update(b"RequestFulfilled")
    .update(&HASH_U64)
    .finalize();

const HASH_BRIDGE_EVENT: [u8; 32] = Keccak256::new()
    .update(&VARIANT_REQUEST_PENDING)
    .update(&VARIANT_REQUEST_FULFILLED)
    .finalize();

// Method FN_HASHes from hash_fn!(@raw kind, name, (args...) -> result):
//   keccak("kind" || "Name" || arg_hashes... || "res" || result_hash)
// Route names: PascalCase of method ident (to_case(Case::Pascal))
// unwrap_result=false → result type IS the full return type; error_type=None (no "throws" line)
// is_command = &mut self receiver; is_query = &self receiver

// request_data(&mut self, payload: String) -> Result<u64, String>
const FN_REQUEST_DATA: [u8; 32] = Keccak256::new()
    .update(b"command")
    .update(b"RequestData")
    .update(&HASH_STRING)     // arg: payload: String
    .update(b"res")
    .update(&HASH_RESULT_U64_STRING)
    .finalize();

// fulfill_request(&mut self, id: u64, result: String) -> Result<(), String>
const FN_FULFILL_REQUEST: [u8; 32] = Keccak256::new()
    .update(b"command")
    .update(b"FulfillRequest")
    .update(&HASH_U64)        // arg: id: u64
    .update(&HASH_STRING)     // arg: result: String
    .update(b"res")
    .update(&HASH_RESULT_UNIT_STRING)
    .finalize();

// query_pending(&self, id: u64) -> Option<String>
const FN_QUERY_PENDING: [u8; 32] = Keccak256::new()
    .update(b"query")
    .update(b"QueryPending")
    .update(&HASH_U64)        // arg: id: u64
    .update(b"res")
    .update(&HASH_OPTION_STRING)
    .finalize();

// relay(&self) -> ActorId
const FN_RELAY: [u8; 32] = Keccak256::new()
    .update(b"query")
    .update(b"Relay")
    // no args
    .update(b"res")
    .update(&HASH_ACTOR_ID)
    .finalize();

// next_id(&self) -> u64
const FN_NEXT_ID: [u8; 32] = Keccak256::new()
    .update(b"query")
    .update(b"NextId")
    // no args
    .update(b"res")
    .update(&HASH_U64)
    .finalize();

// INTERFACE_ID = keccak(fn_hash_0 || fn_hash_1 || ... || events_hash)[0..8]
const INTERFACE_ID_FULL: [u8; 32] = Keccak256::new()
    .update(&FN_REQUEST_DATA)
    .update(&FN_FULFILL_REQUEST)
    .update(&FN_QUERY_PENDING)
    .update(&FN_RELAY)
    .update(&FN_NEXT_ID)
    .update(&HASH_BRIDGE_EVENT)
    .finalize();

fn main() {
    println!("--- Intermediate hashes ---");
    println!("HASH_U64:               {}", hex(&HASH_U64));
    println!("HASH_STRING:            {}", hex(&HASH_STRING));
    println!("HASH_UNIT:              {}", hex(&HASH_UNIT));
    println!("HASH_ACTOR_ID:          {}", hex(&HASH_ACTOR_ID));
    println!("HASH_RESULT_U64_STRING: {}", hex(&HASH_RESULT_U64_STRING));
    println!("HASH_RESULT_UNIT_STRING:{}", hex(&HASH_RESULT_UNIT_STRING));
    println!("HASH_OPTION_STRING:     {}", hex(&HASH_OPTION_STRING));
    println!("VARIANT_REQUEST_PENDING:   {}", hex(&VARIANT_REQUEST_PENDING));
    println!("VARIANT_REQUEST_FULFILLED: {}", hex(&VARIANT_REQUEST_FULFILLED));
    println!("HASH_BRIDGE_EVENT:      {}", hex(&HASH_BRIDGE_EVENT));
    println!();
    println!("--- FN hashes ---");
    println!("FN_REQUEST_DATA:        {}", hex(&FN_REQUEST_DATA));
    println!("FN_FULFILL_REQUEST:     {}", hex(&FN_FULFILL_REQUEST));
    println!("FN_QUERY_PENDING:       {}", hex(&FN_QUERY_PENDING));
    println!("FN_RELAY:               {}", hex(&FN_RELAY));
    println!("FN_NEXT_ID:             {}", hex(&FN_NEXT_ID));
    println!();
    println!("--- INTERFACE_ID ---");
    println!("Full (32 bytes): {}", hex(&INTERFACE_ID_FULL));
    let id = &INTERFACE_ID_FULL[..8];
    println!("INTERFACE_ID (8 bytes): {}", hex(id));
    print!("Array literal: [");
    for (i, b) in id.iter().enumerate() {
        if i > 0 { print!(", "); }
        print!("0x{:02x}", b);
    }
    println!("]");
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|b| format!("{:02x}", b)).collect()
}
