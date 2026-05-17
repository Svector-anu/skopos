// Runs before any test file (Vitest setupFiles).
// Sets required env vars before config.ts is evaluated so required() doesn't throw.
process.env["BRIDGE_PROGRAM_ID"] = "0x0000000000000000000000000000000000000000000000000000000000000000";
process.env["RELAY_SECRET"] = "test-secret";
process.env["SKOPOS_BASE_URL"] = "http://127.0.0.1:19998"; // MockSkopos port used by integration test
process.env["RELAY_DB_PATH"] = "/tmp/relay-test-suite.db";
process.env["RELAY_DEAD_LETTER_PATH"] = "/tmp/relay-test-dead-letter.jsonl";
