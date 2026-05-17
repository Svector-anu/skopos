import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/skopos-client.js", () => ({
  querySkopos: vi.fn(),
}));

import { dispatch, ValidationError } from "../../src/dispatcher.js";
import { querySkopos } from "../../src/skopos-client.js";
import type { BridgePayload } from "../../src/types.js";

const OK_RESULT = { v: "1" as const, id: "1", ok: true as const, data: {}, ts: 1 };

beforeEach(() => {
  vi.mocked(querySkopos).mockResolvedValue(OK_RESULT);
});

describe("dispatch", () => {
  it("forwards all 6 supported types to querySkopos", async () => {
    const types = ["price", "risk", "yield", "markets", "quote", "portfolio"] as const;
    for (const type of types) {
      vi.mocked(querySkopos).mockClear();
      const payload: BridgePayload = { v: "1", type, params: {} };
      const result = await dispatch(1n, payload);
      expect(result.ok).toBe(true);
      expect(querySkopos).toHaveBeenCalledOnce();
    }
  });

  it("throws ValidationError for unknown type without calling querySkopos", async () => {
    vi.mocked(querySkopos).mockClear();
    const payload = { v: "1", type: "unknown_type", params: {} } as unknown as BridgePayload;
    await expect(dispatch(1n, payload)).rejects.toThrow(ValidationError);
    expect(querySkopos).not.toHaveBeenCalled();
  });

  it("passes requestId and payload through to querySkopos", async () => {
    const payload: BridgePayload = { v: "1", type: "price", params: { symbol: "BTC" } };
    await dispatch(99n, payload);
    expect(querySkopos).toHaveBeenCalledWith(99n, payload);
  });

  it("propagates querySkopos result unchanged", async () => {
    const customResult = { v: "1" as const, id: "5", ok: false as const, error: "upstream error", ts: 2 };
    vi.mocked(querySkopos).mockResolvedValue(customResult);
    const result = await dispatch(5n, { v: "1", type: "price", params: {} });
    expect(result).toEqual(customResult);
  });
});
