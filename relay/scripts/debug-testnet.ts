/**
 * Testnet debug: send request_data with route_idx 0 and 1 (separately) and watch
 * ALL gear events in the following block to determine correct dispatch constants.
 *
 * Usage:
 *   BRIDGE_PROGRAM_ID=0x... ROUTE_IDX=0 npx tsx scripts/debug-testnet.ts
 *   BRIDGE_PROGRAM_ID=0x... ROUTE_IDX=1 npx tsx scripts/debug-testnet.ts
 */
import { GearApi, GearKeyring } from "@gear-js/api";
import { WsProvider } from "@polkadot/api";
import { u8aToHex } from "@polkadot/util";

const RPC_WS = process.env.VARA_RPC_WS ?? "wss://testnet.vara.network";
const BRIDGE_PROGRAM_ID = process.env.BRIDGE_PROGRAM_ID!;
if (!BRIDGE_PROGRAM_ID) throw new Error("BRIDGE_PROGRAM_ID required");
const ROUTE_IDX = Number(process.env.ROUTE_IDX ?? "1");

// Correct INTERFACE_ID computed from all 9 methods in alphabetical route order.
// Methods: feeplanks=0, fulfillrequest=1, nextid=2, querypending=3, relay=4, requestdata=5, setfee=6, setrelay=7, withdraw=8
// Route IDs start at 1 in Sails (sails-idl-meta/src/lib.rs: let mut route_id = 1)
const INTERFACE_ID = Uint8Array.from([0x55, 0xc1, 0x09, 0xcd, 0x00, 0x59, 0xcf, 0x2c]);
const REQUEST_DATA_ENTRY_ID = 5; // requestdata is 6th alphabetically (0-indexed = 5)

function sailsHeader(entryId: number, routeIdx: number): Uint8Array {
  const h = new Uint8Array(16);
  h[0]=0x47; h[1]=0x4d; h[2]=0x01; h[3]=0x10;
  h.set(INTERFACE_ID, 4);
  new DataView(h.buffer).setUint16(12, entryId, true);
  h[14]=routeIdx; h[15]=0x00;
  return h;
}
function scaleCompact(n: number): Uint8Array {
  if (n<=63) return new Uint8Array([n<<2]);
  const v=(n<<2)|1; return new Uint8Array([v&0xff,(v>>8)&0xff]);
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const len=parts.reduce((s,p)=>s+p.length,0);
  const out=new Uint8Array(len); let off=0;
  for(const p of parts){out.set(p,off);off+=p.length;}
  return out;
}

async function main() {
  console.log(`[debug] connecting to ${RPC_WS}`);
  console.log(`[debug] bridge: ${BRIDGE_PROGRAM_ID}`);
  console.log(`[debug] route_idx: ${ROUTE_IDX}, entry_id: ${REQUEST_DATA_ENTRY_ID}`);

  const api = await GearApi.create({ provider: new WsProvider(RPC_WS) });
  await api.isReady;
  const alice = await GearKeyring.fromMnemonic("//Alice");
  const aliceId = u8aToHex(alice.publicKey);
  console.log(`[debug] alice: ${aliceId}`);

  const payloadStr = JSON.stringify({v:"1",type:"price",params:{symbol:"ETH"}});
  const payloadBytes = new TextEncoder().encode(payloadStr);
  const header = sailsHeader(REQUEST_DATA_ENTRY_ID, ROUTE_IDX);
  const payload = concat(header, scaleCompact(payloadBytes.length), payloadBytes);
  console.log(`[debug] message header: 0x${Buffer.from(header).toString("hex")}`);

  let sentBlockNum = 0;

  // Subscribe to ALL UserMessageSent events first
  void api.gearEvents.subscribeToGearEvent("UserMessageSent", (event) => {
    const msg = event.data.message;
    const src = msg.source.toHex();
    const dst = msg.destination.toHex();
    const pl = msg.payload.toHex();
    if (src === BRIDGE_PROGRAM_ID.toLowerCase() || dst === aliceId.toLowerCase()) {
      console.log(`\n[debug] *** UserMessageSent from bridge/to-alice ***`);
      console.log(`  source: ${src}`);
      console.log(`  destination: ${dst}`);
      console.log(`  payload (hex): ${pl}`);
      console.log(`  payload length: ${(pl.length - 2) / 2} bytes`);
      // Try to decode as text
      try {
        const bytes = Buffer.from(pl.slice(2), "hex");
        console.log(`  first bytes: ${Array.from(bytes.slice(0,20)).map(b=>`0x${b.toString(16).padStart(2,'0')}`).join(' ')}`);
        console.log(`  as text: ${bytes.toString("utf8").slice(0,200)}`);
      } catch {}
    }
  });

  console.log("\n[debug] sending request_data...");
  await new Promise<void>((resolve, reject) => {
    api.message.send({
      destination: BRIDGE_PROGRAM_ID as `0x${string}`,
      payload,
      gasLimit: 10_000_000_000n,
      value: 0n,
    }).signAndSend(alice, ({ status, events }) => {
      if (status.isInBlock) {
        console.log("[debug] included in block, events in that block:");
        for (const { event } of events) {
          const section = event.section;
          const method = event.method;
          if (section === "gear" || section === "system") {
            console.log(`  ${section}.${method}: ${JSON.stringify(event.data.toJSON()).slice(0, 500)}`);
          }
        }
        sentBlockNum = Number((status as { asInBlock: { toString(): string } }).asInBlock?.toString() ?? 0);
        resolve();
      }
      if (status.isDropped || status.isInvalid) reject(new Error("dropped/invalid"));
    }).catch(reject);
  });

  console.log("\n[debug] watching next 5 finalized blocks for gear events...");
  let count = 0;
  await new Promise<void>((resolve) => {
    void api.rpc.chain.subscribeFinalizedHeads(async (header) => {
      if (count >= 5) { resolve(); return; }
      count++;
      const num = header.number.toNumber();
      const hash = await api.rpc.chain.getBlockHash(num);
      const evts = await api.query.system.events.at(hash);
      const gearEvts = (evts as unknown as Array<{event: {section:string;method:string;data:{toJSON():unknown}}}>)
        .filter(r => r.event.section === "gear");
      if (gearEvts.length > 0) {
        console.log(`\n[debug] block ${num}: ${gearEvts.length} gear event(s):`);
        for (const r of gearEvts) {
          const data = JSON.stringify(r.event.data.toJSON());
          console.log(`  gear.${r.event.method}: ${data.slice(0, 600)}`);
        }
      } else {
        console.log(`[debug] block ${num}: no gear events`);
      }
      if (count >= 5) resolve();
    });
  });

  await api.disconnect();
  console.log("[debug] done");
}

main().catch(e=>{console.error(e);process.exit(1);});
