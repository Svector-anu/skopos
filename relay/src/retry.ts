import fs from "node:fs";
import { config } from "./config.js";
import { ValidationError } from "./dispatcher.js";
import type { BridgeResult, InFlightRequest } from "./types.js";

const DELAYS_MS = [5_000, 15_000, 45_000];

export async function withRetry(
  req: InFlightRequest,
  fn: () => Promise<BridgeResult>,
  onAttempt: (retryCount: number) => void,
): Promise<BridgeResult> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = DELAYS_MS[attempt - 1];
      console.log(`[retry] id=${req.id}: attempt ${attempt + 1} in ${delay / 1000}s`);
      await sleep(delay);
    }
    try {
      const result = await fn();
      if (result.ok) return result;
      // Skopos returned an explicit error result (e.g. HTTP 4xx) — retry.
      lastError = new Error(result.error ?? "skopos error");
    } catch (err) {
      // ValidationError = bad payload schema, not a transient failure. Never retry.
      if (err instanceof ValidationError) {
        return {
          v: "1",
          id: req.id.toString(),
          ok: false,
          error: (err as Error).message,
          ts: Math.floor(Date.now() / 1000),
        };
      }
      lastError = err;
    }
    onAttempt(attempt + 1);
  }

  const errorMessage = lastError instanceof Error ? lastError.message : String(lastError);
  writeDeadLetter(req, errorMessage);
  return {
    v: "1",
    id: req.id.toString(),
    ok: false,
    error: `relay gave up after ${DELAYS_MS.length + 1} attempts: ${errorMessage}`,
    ts: Math.floor(Date.now() / 1000),
  };
}

function writeDeadLetter(req: InFlightRequest, reason: string): void {
  // Scrub wallet addresses and amounts before writing to disk.
  // Full payload is logged server-side only for forensics; the file may be
  // shipped to external log aggregators that should not see user wallet data.
  const scrubbedParams = req.payload?.params
    ? Object.fromEntries(
        Object.entries(req.payload.params as Record<string, unknown>).map(([k, v]) => {
          const sensitive = /address|wallet|sender|receiver|recipient/i.test(k);
          return [k, sensitive ? "[redacted]" : v];
        }),
      )
    : req.payload?.params;
  const entry = JSON.stringify({
    id: req.id.toString(),
    caller: "[redacted]",
    payload: { ...req.payload, params: scrubbedParams },
    reason,
    ts: new Date().toISOString(),
  });
  try {
    fs.appendFileSync(config.deadLetterPath, entry + "\n");
    console.error(`[retry] id=${req.id}: dead-lettered → ${config.deadLetterPath}`);
  } catch (err) {
    console.error(`[retry] id=${req.id}: failed to write dead-letter:`, err);
  }

  if (config.deadLetterWebhookUrl) {
    fetch(config.deadLetterWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: entry,
      signal: AbortSignal.timeout(5_000),
    }).catch((err) => {
      console.error(`[retry] id=${req.id}: webhook notify failed:`, err);
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
