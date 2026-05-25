function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function validateSkoposUrl(raw: string): string {
  let parsed: URL;
  try { parsed = new URL(raw); } catch {
    throw new Error(`SKOPOS_BASE_URL is not a valid URL: ${raw}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`SKOPOS_BASE_URL: disallowed protocol ${parsed.protocol}`);
  }
  const allowedHosts = new Set(["tryskopos.xyz", "www.tryskopos.xyz", "localhost", "127.0.0.1"]);
  if (process.env.NODE_ENV === "production" && !allowedHosts.has(parsed.hostname)) {
    throw new Error(`SKOPOS_BASE_URL: disallowed host ${parsed.hostname} in production`);
  }
  return raw;
}

const relayMnemonic = process.env.RELAY_MNEMONIC ?? null;
const relayWalletJson = process.env.RELAY_WALLET_JSON ?? null;

if (!relayMnemonic && !relayWalletJson) {
  throw new Error("Either RELAY_MNEMONIC or RELAY_WALLET_JSON must be set");
}
if (relayMnemonic && relayWalletJson) {
  throw new Error("Set only one of RELAY_MNEMONIC or RELAY_WALLET_JSON, not both");
}

const relaySecret = process.env.RELAY_SECRET ?? null;
if (!relaySecret) {
  throw new Error("RELAY_SECRET must be set — do not use the default in any environment");
}

export const config = {
  rpcWs: process.env.VARA_RPC_WS ?? "ws://127.0.0.1:9944",
  bridgeProgramId: required("BRIDGE_PROGRAM_ID"),
  relayMnemonic: relayMnemonic ?? "//unreachable",
  relayWalletJson,
  skoposBaseUrl: validateSkoposUrl(process.env.SKOPOS_BASE_URL ?? "http://localhost:3000"),
  relaySecret,
  dbPath: process.env.RELAY_DB_PATH ?? "./relay.db",
  deadLetterPath: process.env.RELAY_DEAD_LETTER_PATH ?? "./dead-letter.jsonl",
  healthPort: process.env.RELAY_HEALTH_PORT ? Number(process.env.RELAY_HEALTH_PORT) : 3001,
  deadLetterWebhookUrl: process.env.RELAY_DEAD_LETTER_WEBHOOK_URL ?? null,

  // Chat agent — autonomous reply loop for @skopos-agent2 / @skopos-bridge mentions
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  vanPid: process.env.VAN_PID ?? "0x19f27f4c906a5ac230be82d907850d44c7a7fff1b4c6903f62e78e09e0b353f3",
  agentProgramHex: process.env.AGENT_PROGRAM_HEX ?? "0x422d323915e5d3ac00a41138da14d6a13bccf753407bf6fc0079ff746ae5ce8b",
  varaAccount: process.env.VARA_ACCOUNT ?? "skopos-agent",
  operatorHex: process.env.OPERATOR_HEX ?? "",
  voucherId: process.env.VOUCHER_ID ?? "",
  vanIdl: process.env.VAN_IDL ?? new URL("../../idl/agents_network_client.idl", import.meta.url).pathname,
  varaNetwork: process.env.VARA_NETWORK ?? "mainnet",
};
