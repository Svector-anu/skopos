/**
 * Integration test: full handleRequest lifecycle without a live Gear node.
 *
 * Real:    SQLite (temp file), HTTP calls to MockSkopos server, retry logic
 * Mocked:  chain-writer only — fulfillRequest needs a live Gear node to sign extrinsics
 *
 * SKOPOS_BASE_URL is set to http://127.0.0.1:19998 by test/setup.ts, which runs
 * before config.ts is first evaluated, so skopos-client.ts picks it up correctly.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { existsSync, unlinkSync } from "node:fs";
import type { GearApi } from "@gear-js/api";

vi.mock("../../src/chain-writer.js", () => ({
  fulfillRequest: vi.fn().mockResolvedValue(undefined),
}));

import { handleRequest } from "../../src/subscription.js";
import { closeDb, loadPendingRequests } from "../../src/request-state.js";
import { fulfillRequest } from "../../src/chain-writer.js";
import type { InFlightRequest } from "../../src/types.js";

const DB_PATH = process.env["RELAY_DB_PATH"]!;
const MOCK_PORT = 19998;

// ------------------------------------------------------------------
// MockSkopos — real HTTP server, canned responses per queryType
// ------------------------------------------------------------------

const mockResponses = new Map<string, unknown>();
let mockServer: http.Server;

beforeAll(() => new Promise<void>((resolve) => {
  mockServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      const auth = req.headers["authorization"];
      if (auth !== `Bearer ${process.env["RELAY_SECRET"]}`) {
        res.writeHead(401); res.end(JSON.stringify({ error: "unauthorized" })); return;
      }
      const { queryType } = JSON.parse(body) as { queryType: string };
      const stub = mockResponses.get(queryType);
      if (!stub) {
        res.writeHead(400); res.end(JSON.stringify({ error: `unknown queryType: ${queryType}` })); return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: JSON.stringify(stub) }));
    });
  });
  mockServer.listen(MOCK_PORT, "127.0.0.1", resolve);
}));

afterAll(() => new Promise<void>((resolve) => mockServer.close(() => resolve())));

beforeEach(() => {
  mockResponses.clear();
  vi.mocked(fulfillRequest).mockClear();
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
});

afterEach(() => {
  closeDb();
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
});

// ------------------------------------------------------------------

const fakeApi = null as unknown as GearApi;

function makeReq(id: bigint, type: string = "price"): InFlightRequest {
  return {
    id,
    caller: "0xcafebabe",
    payload: { v: "1", type: type as "price", params: { symbol: "ETH" } },
    status: "pending",
    retryCount: 0,
  };
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

describe("happy path", () => {
  it("queries MockSkopos, calls fulfillRequest, request leaves pending state", async () => {
    mockResponses.set("price", { symbol: "ETH", price: 3200, source: "stub" });

    await handleRequest(fakeApi, makeReq(1n));

    expect(fulfillRequest).toHaveBeenCalledOnce();
    const [, , id, result] = vi.mocked(fulfillRequest).mock.calls[0];
    expect(id).toBe(1n);
    expect(result.ok).toBe(true);
    expect(loadPendingRequests()).toHaveLength(0);
  });

  it("result has correct id, version, and ts", async () => {
    mockResponses.set("price", { price: 100 });
    await handleRequest(fakeApi, makeReq(7n));
    const [, , , result] = vi.mocked(fulfillRequest).mock.calls[0];
    expect(result.v).toBe("1");
    expect(result.id).toBe("7");
    expect(typeof result.ts).toBe("number");
  });

  it("passes parsed skopos data through to fulfillRequest", async () => {
    const priceData = { symbol: "BTC", price: 70000, change24h: 2.5, source: "coingecko" };
    mockResponses.set("price", priceData);
    await handleRequest(fakeApi, makeReq(3n));
    const [, , , result] = vi.mocked(fulfillRequest).mock.calls[0];
    expect(result.data).toEqual(priceData);
  });
});

describe("skopos failure path", () => {
  it("does not call fulfillRequest when queryType is unsupported", async () => {
    // no stub registered → MockSkopos returns 400
    vi.useFakeTimers();
    const promise = handleRequest(fakeApi, makeReq(2n, "unsupported_type"));
    await vi.runAllTimersAsync();
    await promise;
    vi.useRealTimers();

    expect(fulfillRequest).not.toHaveBeenCalled();
    expect(loadPendingRequests()).toHaveLength(0);
  });

  it("request ends in failed state when MockSkopos returns unknown queryType error", async () => {
    // Dispatcher catches unsupported type before any HTTP call — no retries, returns error immediately
    await handleRequest(fakeApi, makeReq(3n, "unsupported_type"));

    expect(fulfillRequest).not.toHaveBeenCalled();
    expect(loadPendingRequests()).toHaveLength(0);
  });
});

describe("all 6 query types", () => {
  it.each([
    ["price",     { symbol: "ETH", price: 3200, source: "coingecko" }],
    ["risk",      { token: "0xabc", chain: "ethereum", score: 2, flags: [] }],
    ["yield",     { pools: [{ protocol: "aave-v3", apy: 4.5 }] }],
    ["markets",   { markets: [{ title: "ETH > $5k?", probability: 0.3 }] }],
    ["quote",     { outputAmount: "0.98 ETH", adapter: "across" }],
    ["portfolio", { address: "0xabc", balances: [] }],
  ])("%s routes to MockSkopos and gets fulfilled", async (type, stub) => {
    mockResponses.set(type, stub);
    await handleRequest(fakeApi, makeReq(1n, type));
    expect(fulfillRequest).toHaveBeenCalledOnce();
    const [, , , result] = vi.mocked(fulfillRequest).mock.calls[0];
    expect(result.ok).toBe(true);
  });
});
