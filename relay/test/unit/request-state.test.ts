import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";

// RELAY_DB_PATH is set by test/setup.ts before this file is evaluated
const TEST_DB = process.env["RELAY_DB_PATH"]!;

import {
  getCursor,
  saveCursor,
  insertRequest,
  updateRequestStatus,
  loadPendingRequests,
  closeDb,
} from "../../src/request-state.js";
import type { InFlightRequest } from "../../src/types.js";

const PROGRAM_ID = "0xdeadbeef";

function makeReq(id: bigint, status: InFlightRequest["status"] = "pending"): InFlightRequest {
  return {
    id,
    caller: "0xcafe",
    payload: { v: "1", type: "price", params: { symbol: "ETH" } },
    status,
    retryCount: 0,
  };
}

beforeEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

afterEach(() => {
  closeDb();
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

describe("cursor", () => {
  it("starts at 0", () => {
    expect(getCursor()).toBe(0);
  });

  it("round-trips saveCursor → getCursor", () => {
    saveCursor(12345);
    expect(getCursor()).toBe(12345);
    saveCursor(99999);
    expect(getCursor()).toBe(99999);
  });
});

describe("insertRequest", () => {
  it("inserts a new request and returns true", () => {
    expect(insertRequest(makeReq(1n), PROGRAM_ID, 100)).toBe(true);
  });

  it("returns false on duplicate (INSERT OR IGNORE)", () => {
    insertRequest(makeReq(1n), PROGRAM_ID, 100);
    expect(insertRequest(makeReq(1n), PROGRAM_ID, 101)).toBe(false);
  });

  it("allows same id under different program_ids", () => {
    expect(insertRequest(makeReq(1n), "0xprog1", 100)).toBe(true);
    expect(insertRequest(makeReq(1n), "0xprog2", 100)).toBe(true);
  });
});

describe("updateRequestStatus", () => {
  it("updates status in DB", () => {
    insertRequest(makeReq(1n), PROGRAM_ID, 100);
    updateRequestStatus(1n, PROGRAM_ID, "submitting");
    const rows = loadPendingRequests();
    expect(rows[0].status).toBe("submitting");
  });

  it("updates retry_count when provided", () => {
    insertRequest(makeReq(1n), PROGRAM_ID, 100);
    updateRequestStatus(1n, PROGRAM_ID, "querying", 3);
    const rows = loadPendingRequests();
    expect(rows[0].retryCount).toBe(3);
  });
});

describe("loadPendingRequests", () => {
  it("returns pending, querying, and submitting rows", () => {
    insertRequest(makeReq(1n), PROGRAM_ID, 100);
    insertRequest(makeReq(2n), PROGRAM_ID, 100);
    updateRequestStatus(2n, PROGRAM_ID, "querying");
    insertRequest(makeReq(3n), PROGRAM_ID, 100);
    updateRequestStatus(3n, PROGRAM_ID, "submitting");

    const rows = loadPendingRequests();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.id).sort()).toEqual([1n, 2n, 3n]);
  });

  it("excludes done and failed rows", () => {
    insertRequest(makeReq(1n), PROGRAM_ID, 100);
    updateRequestStatus(1n, PROGRAM_ID, "done");
    insertRequest(makeReq(2n), PROGRAM_ID, 100);
    updateRequestStatus(2n, PROGRAM_ID, "failed");
    expect(loadPendingRequests()).toHaveLength(0);
  });

  it("deserializes payload JSON correctly", () => {
    insertRequest(makeReq(1n), PROGRAM_ID, 100);
    const [row] = loadPendingRequests();
    expect(row.payload).toMatchObject({ v: "1", type: "price", params: { symbol: "ETH" } });
  });
});
