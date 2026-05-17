import { config } from "./config.js";
import type { BridgePayload, BridgeResult } from "./types.js";

export async function querySkopos(requestId: bigint, payload: BridgePayload): Promise<BridgeResult> {
  const url = `${config.skoposBaseUrl}/api/vara`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.relaySecret}`,
    },
    body: JSON.stringify({ queryType: payload.type, params: payload.params }),
    signal: AbortSignal.timeout(8000),
  });

  const id = requestId.toString();
  const ts = Math.floor(Date.now() / 1000);

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    return { v: "1", id, ok: false, error: `skopos ${res.status}: ${text}`, ts };
  }

  const json = await res.json() as { result?: string; error?: string };
  if (json.error) return { v: "1", id, ok: false, error: json.error, ts };

  return { v: "1", id, ok: true, data: JSON.parse(json.result ?? "null"), ts };
}
