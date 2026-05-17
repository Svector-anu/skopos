function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const config = {
  rpcWs: process.env.VARA_RPC_WS ?? "ws://127.0.0.1:9944",
  bridgeProgramId: required("BRIDGE_PROGRAM_ID"),
  relayMnemonic: process.env.RELAY_MNEMONIC ?? "//Alice",
  relayWalletJson: process.env.RELAY_WALLET_JSON ?? null,
  skoposBaseUrl: process.env.SKOPOS_BASE_URL ?? "http://localhost:3000",
  relaySecret: process.env.RELAY_SECRET ?? "local-dev-secret",
  dbPath: process.env.RELAY_DB_PATH ?? "./relay.db",
  deadLetterPath: process.env.RELAY_DEAD_LETTER_PATH ?? "./dead-letter.jsonl",
  healthPort: process.env.RELAY_HEALTH_PORT ? Number(process.env.RELAY_HEALTH_PORT) : 3001,
  deadLetterWebhookUrl: process.env.RELAY_DEAD_LETTER_WEBHOOK_URL ?? null,
};
