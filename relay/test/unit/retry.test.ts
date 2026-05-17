import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { withRetry } from "../../src/retry.js";
import type { InFlightRequest } from "../../src/types.js";

const DEAD_LETTER = process.env["RELAY_DEAD_LETTER_PATH"]!;

const FAKE_REQ: InFlightRequest = {
  id: 42n,
  caller: "0xabc",
  payload: { v: "1", type: "price", params: { symbol: "ETH" } },
  status: "querying",
  retryCount: 0,
};

beforeEach(() => {
  vi.useFakeTimers();
  if (existsSync(DEAD_LETTER)) unlinkSync(DEAD_LETTER);
});

afterEach(() => {
  vi.useRealTimers();
  if (existsSync(DEAD_LETTER)) unlinkSync(DEAD_LETTER);
});

describe("withRetry", () => {
  it("returns result immediately on first-attempt success", async () => {
    const fn = vi.fn().mockResolvedValue({ v: "1", id: "42", ok: true, data: { price: 3200 }, ts: 1 });
    const onAttempt = vi.fn();

    const promise = withRetry(FAKE_REQ, fn, onAttempt);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.ok).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onAttempt).toHaveBeenCalledTimes(0);
    expect(existsSync(DEAD_LETTER)).toBe(false);
  });

  it("retries after failure and succeeds on second attempt", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue({ v: "1", id: "42", ok: true, data: {}, ts: 1 });
    const onAttempt = vi.fn();

    const promise = withRetry(FAKE_REQ, fn, onAttempt);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.ok).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onAttempt).toHaveBeenCalledTimes(1);
    expect(onAttempt).toHaveBeenCalledWith(1);
  });

  it("exhausts all 4 attempts and dead-letters on total failure", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("skopos down"));
    const onAttempt = vi.fn();

    const promise = withRetry(FAKE_REQ, fn, onAttempt);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/gave up after 4 attempts/);
    expect(fn).toHaveBeenCalledTimes(4);
    // onAttempt fired after attempts 0, 1, 2, 3 → 4 times
    expect(onAttempt).toHaveBeenCalledTimes(4);
    expect(existsSync(DEAD_LETTER)).toBe(true);
  });

  it("dead-letter entry is valid JSON with id, caller, payload, reason", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("connection refused"));
    const promise = withRetry(FAKE_REQ, fn, vi.fn());
    await vi.runAllTimersAsync();
    await promise;

    const line = readFileSync(DEAD_LETTER, "utf8").trim();
    const entry = JSON.parse(line);
    expect(entry.id).toBe("42");
    expect(entry.caller).toBe("0xabc");
    expect(entry.reason).toMatch(/connection refused/);
    expect(entry.ts).toBeTruthy();
  });

  it("treats ok=false result from skopos as failure and retries", async () => {
    const errorResult = { v: "1" as const, id: "42", ok: false as const, error: "upstream 503", ts: 1 };
    const successResult = { v: "1" as const, id: "42", ok: true as const, data: {}, ts: 1 };
    const fn = vi.fn()
      .mockResolvedValueOnce(errorResult)
      .mockResolvedValue(successResult);

    const promise = withRetry(FAKE_REQ, fn, vi.fn());
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.ok).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
