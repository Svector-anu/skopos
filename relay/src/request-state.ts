import Database from "better-sqlite3";
import { config } from "./config.js";
import type { BridgePayload, InFlightRequest } from "./types.js";

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (!_db) {
    _db = new Database(config.dbPath);
    _db.pragma("journal_mode = WAL");
    _db.pragma("synchronous = NORMAL");
    initSchema(_db);
  }
  return _db;
}

function initSchema(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS cursor (
      id    INTEGER PRIMARY KEY CHECK (id = 1),
      block INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO cursor (id, block) VALUES (1, 0);

    CREATE TABLE IF NOT EXISTS requests (
      id           TEXT NOT NULL,
      program_id   TEXT NOT NULL,
      caller       TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      retry_count  INTEGER NOT NULL DEFAULT 0,
      created_block INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (id, program_id)
    );
    CREATE INDEX IF NOT EXISTS idx_requests_status ON requests (status);
  `);
}

export function getCursor(): number {
  const row = db().prepare("SELECT block FROM cursor WHERE id = 1").get() as { block: number };
  return row.block;
}

export function saveCursor(block: number): void {
  db().prepare("UPDATE cursor SET block = ? WHERE id = 1").run(block);
}

export function insertRequest(req: InFlightRequest, programId: string, block: number): boolean {
  const stmt = db().prepare(`
    INSERT OR IGNORE INTO requests (id, program_id, caller, payload_json, status, retry_count, created_block, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    req.id.toString(),
    programId,
    req.caller,
    JSON.stringify(req.payload),
    req.status,
    req.retryCount,
    block,
    Date.now(),
  );
  return result.changes > 0;
}

export function updateRequestStatus(
  id: bigint,
  programId: string,
  status: InFlightRequest["status"],
  retryCount?: number,
): void {
  const stmt = retryCount !== undefined
    ? db().prepare("UPDATE requests SET status = ?, retry_count = ?, updated_at = ? WHERE id = ? AND program_id = ?")
    : db().prepare("UPDATE requests SET status = ?, updated_at = ? WHERE id = ? AND program_id = ?");

  if (retryCount !== undefined) {
    stmt.run(status, retryCount, Date.now(), id.toString(), programId);
  } else {
    stmt.run(status, Date.now(), id.toString(), programId);
  }
}

export function loadPendingRequests(): Array<InFlightRequest & { programId: string }> {
  const rows = db().prepare(`
    SELECT id, program_id, caller, payload_json, status, retry_count
    FROM requests
    WHERE status IN ('pending', 'querying', 'submitting')
  `).all() as Array<{
    id: string;
    program_id: string;
    caller: string;
    payload_json: string;
    status: string;
    retry_count: number;
  }>;

  return rows.map((r) => ({
    id: BigInt(r.id),
    programId: r.program_id,
    caller: r.caller,
    payload: JSON.parse(r.payload_json) as BridgePayload,
    status: r.status as InFlightRequest["status"],
    retryCount: r.retry_count,
  }));
}

export function queryStats(): { pending: number; querying: number; submitting: number; failed: number; done: number } {
  const rows = db().prepare(
    "SELECT status, COUNT(*) as count FROM requests GROUP BY status"
  ).all() as Array<{ status: string; count: number }>;
  const stats = { pending: 0, querying: 0, submitting: 0, failed: 0, done: 0 };
  for (const row of rows) {
    if (row.status in stats) stats[row.status as keyof typeof stats] = row.count;
  }
  return stats;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}
