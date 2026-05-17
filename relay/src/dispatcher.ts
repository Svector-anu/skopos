import type { BridgePayload, BridgeResult } from "./types.js";
import { querySkopos } from "./skopos-client.js";

const SUPPORTED_TYPES = new Set(["price", "risk", "yield", "markets", "quote", "portfolio"]);

// Thrown for validation failures that must NOT be retried (equivalent to HTTP 4xx).
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export async function dispatch(requestId: bigint, payload: BridgePayload): Promise<BridgeResult> {
  if (!SUPPORTED_TYPES.has(payload.type)) {
    throw new ValidationError(`unsupported query type: ${payload.type}`);
  }
  return querySkopos(requestId, payload);
}
