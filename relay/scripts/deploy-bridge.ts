/**
 * Deploy skopos_bridge.wasm to a Vara network (testnet or mainnet).
 *
 * Environment variables:
 *   VARA_RPC_WS          RPC endpoint (default: wss://testnet.vara.network)
 *   DEPLOY_MNEMONIC      Deployer mnemonic (default: //Alice for local dev only)
 *   DEPLOY_WALLET_JSON   Path to a vara-wallet JSON file (alternative to mnemonic)
 *   RELAY_HEX            Relay wallet public key hex (default: same as deployer)
 *   FEE_PLANKS           Minimum fee in planks (default: 0)
 *   WASM_RELEASE         Set to "1" to use release WASM (default: release)
 *
 * Usage:
 *   # Testnet with vara-wallet JSON:
 *   VARA_RPC_WS=wss://testnet.vara.network \
 *   DEPLOY_WALLET_JSON=~/.vara-wallet/wallets/skopos-agent.json \
 *   npx tsx scripts/deploy-bridge.ts
 *
 *   # Testnet with mnemonic:
 *   VARA_RPC_WS=wss://testnet.vara.network \
 *   DEPLOY_MNEMONIC="word1 word2 ..." \
 *   npx tsx scripts/deploy-bridge.ts
 */
import { GearApi, GearKeyring } from "@gear-js/api";
import { Keyring } from "@polkadot/keyring";
import { WsProvider } from "@polkadot/api";
import type { KeyringPair } from "@polkadot/keyring/types";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RPC_WS = process.env.VARA_RPC_WS ?? "wss://testnet.vara.network";
const WASM_PATH = resolve(
  "../gear-bridge/target/wasm32-gear/release/skopos_bridge.opt.wasm"
);
const FEE_PLANKS = BigInt(process.env.FEE_PLANKS ?? "0");

async function loadDeployer(): Promise<KeyringPair> {
  if (process.env.DEPLOY_WALLET_JSON) {
    const jsonPath = process.env.DEPLOY_WALLET_JSON.replace(/^~/, process.env.HOME ?? "");
    const json = JSON.parse(readFileSync(jsonPath, "utf8"));
    const kr = new Keyring({ type: "sr25519" });
    const pair = kr.addFromJson(json);
    pair.unlock("");
    return pair;
  }
  const mnemonic = process.env.DEPLOY_MNEMONIC ?? "//Alice";
  return GearKeyring.fromMnemonic(mnemonic);
}

async function main() {
  console.log(`[deploy] connecting to ${RPC_WS}`);
  const provider = new WsProvider(RPC_WS);
  const api = await GearApi.create({ provider });
  await api.isReady;
  console.log("[deploy] connected");

  const deployer = await loadDeployer();
  const deployerHex = `0x${Buffer.from(deployer.publicKey).toString("hex")}`;
  console.log(`[deploy] deployer/admin: ${deployerHex}`);

  const relayHex = process.env.RELAY_HEX ?? deployerHex;
  const relayBytes = Buffer.from(relayHex.replace(/^0x/, ""), "hex");
  if (relayBytes.length !== 32) throw new Error(`RELAY_HEX must be 32 bytes (64 hex chars), got ${relayBytes.length}`);
  console.log(`[deploy] relay wallet: 0x${relayBytes.toString("hex")}`);
  console.log(`[deploy] fee_planks:   ${FEE_PLANKS}`);

  // Sails 1.0.0-beta.5 constructor payload:
  //   [GM magic 2B][version 1B][hlen 1B][interface_id 8B zero][entry_id u16LE][route_id 1B][reserved 1B]
  //   + admin ActorId (32B) + relay ActorId (32B) + fee_planks u128 LE (16B)
  // Constructors use all-zero interface_id (no service dispatch).
  const initHeader = new Uint8Array([0x47, 0x4D, 0x01, 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const feePlanksLE = new Uint8Array(16);
  new DataView(feePlanksLE.buffer).setBigUint64(0, FEE_PLANKS & 0xFFFFFFFFFFFFFFFFn, true);
  new DataView(feePlanksLE.buffer).setBigUint64(8, FEE_PLANKS >> 64n, true);

  const initPayload = new Uint8Array([
    ...initHeader,
    ...deployer.publicKey,   // admin
    ...relayBytes,           // relay
    ...feePlanksLE,          // fee_planks
  ]);

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
    api.program.signAndSend(deployer, ({ status }) => {
      if (status.isInBlock) {
        console.log(`\n[deploy] bridge deployed!`);
        console.log(`BRIDGE_PROGRAM_ID=${programId}`);
        resolve();
      }
      if (status.isDropped || status.isInvalid) {
        reject(new Error("extrinsic dropped/invalid"));
      }
    }).catch(reject);
  });

  await api.disconnect();

  const network = RPC_WS.includes("testnet") ? "testnet" : "mainnet";
  console.log(`\n[deploy] run relay against ${network}:`);
  console.log(`  BRIDGE_PROGRAM_ID=${programId} VARA_RPC_WS=${RPC_WS} npx tsx src/index.ts`);
  console.log(`\n[deploy] run E2E test:`);
  console.log(`  BRIDGE_PROGRAM_ID=${programId} VARA_RPC_WS=${RPC_WS} npx tsx scripts/test-request.ts`);
}

main().catch((err) => {
  console.error("[deploy] error:", err);
  process.exit(1);
});
