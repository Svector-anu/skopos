/**
 * Deploy skopos_bridge.opt.wasm to a local gear --dev node.
 * Usage: npx tsx scripts/deploy-bridge.ts
 */
import { GearApi, GearKeyring } from "@gear-js/api";
import { WsProvider } from "@polkadot/api";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RPC_WS = process.env.VARA_RPC_WS ?? "ws://127.0.0.1:9944";
const WASM_PATH = resolve(
  "../gear-bridge/target/wasm32-unknown-unknown/debug/skopos_bridge.wasm"
);

async function main() {
  console.log(`[deploy] connecting to ${RPC_WS}`);
  const provider = new WsProvider(RPC_WS);
  const api = await GearApi.create({ provider });
  await api.isReady;
  console.log("[deploy] connected");

  const alice = await GearKeyring.fromMnemonic("//Alice");
  console.log(`[deploy] deployer/relay/admin: 0x${Buffer.from(alice.publicKey).toString("hex")}`);

  // Sails constructor payload: 16-byte header + new(admin: ActorId, relay: ActorId, fee_planks: u128)
  // Header: [GM magic][version=1][hlen=16][interface_id:8 zero bytes][entry_id:u16LE=0][route_id=0][reserved=0]
  // Constructors use all-zero interface_id (no service dispatch).
  // fee_planks=0 for local dev (no fee enforcement).
  const initHeader = new Uint8Array([0x47, 0x4D, 0x01, 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const feePlanks = new Uint8Array(16); // 0n as u128 little-endian
  const initPayload = new Uint8Array([...initHeader, ...alice.publicKey, ...alice.publicKey, ...feePlanks]);

  const code = readFileSync(WASM_PATH);
  const saltBytes = crypto.getRandomValues(new Uint8Array(32));
  const salt = `0x${Buffer.from(saltBytes).toString("hex")}` as `0x${string}`;

  console.log("[deploy] uploading program...");
  const { programId } = api.program.upload({
    code,
    salt,
    initPayload: `0x${Buffer.from(initPayload).toString("hex")}`,
    gasLimit: 50_000_000_000n,
    value: 0n,
  });

  await new Promise<void>((resolve, reject) => {
    api.program.signAndSend(alice, ({ status }) => {
      if (status.isInBlock) {
        console.log(`\n[deploy] ✅ bridge deployed!`);
        console.log(`BRIDGE_PROGRAM_ID=${programId}`);
        resolve();
      }
      if (status.isDropped || status.isInvalid) {
        reject(new Error("extrinsic dropped/invalid"));
      }
    }).catch(reject);
  });

  await api.disconnect();
  console.log(`\n[deploy] run relay with:`);
  console.log(`  BRIDGE_PROGRAM_ID=${programId} VARA_RPC_WS=ws://127.0.0.1:9944 npx tsx src/index.ts`);
  console.log(`\n[deploy] run E2E test with:`);
  console.log(`  BRIDGE_PROGRAM_ID=${programId} npx tsx scripts/test-request.ts`);
}

main().catch((err) => {
  console.error("[deploy] error:", err);
  process.exit(1);
});
