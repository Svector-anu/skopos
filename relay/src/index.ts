import http from "node:http";
import { GearApi } from "@gear-js/api";
import { WsProvider } from "@polkadot/api";
import { config } from "./config.js";
import { startSubscription, waitForDrain } from "./subscription.js";
import { startChatAgent, startProactiveBroadcast, startHerald } from "./chat-agent.js";
import { closeDb, getCursor, queryStats } from "./request-state.js";

async function main(): Promise<void> {
  console.log("[relay] starting...");
  console.log(`[relay] RPC: ${config.rpcWs}`);
  console.log(`[relay] bridge: ${config.bridgeProgramId}`);
  console.log(`[relay] skopos: ${config.skoposBaseUrl}`);
  console.log(`[relay] db: ${config.dbPath}`);

  const provider = new WsProvider(config.rpcWs);
  const api = await GearApi.create({ provider });
  await api.isReady;

  const [chain, nodeName, nodeVersion] = await Promise.all([
    api.rpc.system.chain(),
    api.rpc.system.name(),
    api.rpc.system.version(),
  ]);
  console.log(`[relay] connected: ${chain} / ${nodeName} v${nodeVersion}`);

  let shuttingDown = false;

  const healthServer = http.createServer((_req, res) => {
    const body = JSON.stringify({
      status: shuttingDown ? "shutting_down" : "running",
      lastBlock: getCursor(),
      db: queryStats(),
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
  });
  healthServer.listen(config.healthPort, "0.0.0.0", () => {
    console.log(`[relay] health check: http://0.0.0.0:${config.healthPort}/`);
  });

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[relay] ${signal} received — draining in-flight requests (up to 30s)`);
    await waitForDrain(30_000);
    healthServer.close();
    await api.disconnect();
    closeDb();
    console.log("[relay] shutdown complete");
    process.exit(0);
  }

  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT",  () => { void shutdown("SIGINT"); });

  await startSubscription(api);

  if (config.groqApiKey && config.voucherId) {
    const agentConfig = {
      groqApiKey: config.groqApiKey,
      varaAccount: config.varaAccount,
      operatorHex: config.operatorHex,
      voucherId: config.voucherId,
      vanPid: config.vanPid,
      agentProgramHex: config.agentProgramHex,
      varaNetwork: config.varaNetwork,
      vanIdl: config.vanIdl,
      relaySecret: config.relaySecret,
      skoposBaseUrl: config.skoposBaseUrl,
    };
    startChatAgent(agentConfig);
    startProactiveBroadcast(agentConfig);
    const heraldAccount = process.env.HERALD_ACCOUNT ?? "";
    if (heraldAccount) startHerald(agentConfig, heraldAccount);
    else console.log("[herald] disabled — set HERALD_ACCOUNT to enable");
  } else {
    console.warn("[relay] chat-agent disabled — set GROQ_API_KEY, VOUCHER_ID, VAN_IDL to enable");
  }
}

main().catch((err) => {
  console.error("[relay] fatal:", err);
  closeDb();
  process.exit(1);
});
