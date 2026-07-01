// Bankr Agent API client. Skopos sends a natural-language prompt to a Bankr agent
// that has the Aeon skills installed; the agent runs the skill and returns text.
// Async job model: submit → poll → result. Gated on BANKR_AGENT_KEY (a bk_ Agent
// API key); unset → the Aeon reads simply aren't offered. Separate from
// BANKR_LLM_KEY (the Smart-tier text gateway).

const BASE = "https://api.bankr.bot";
const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface AgentResponse {
  ok: boolean;
  text?: string;
  error?: string;
}

function agentKey(): string | null {
  const k = process.env.BANKR_AGENT_KEY?.trim();
  return k && k.startsWith("bk_") ? k : null;
}

export function aeonEnabled(): boolean {
  return agentKey() !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function timedFetch(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function asText(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// The job result shape isn't pinned in the docs, so pull the text defensively from
// the fields an agent response is likely to carry.
function extractText(job: unknown): string | null {
  const direct = asText(job);
  if (direct) return direct;
  if (!job || typeof job !== "object") return null;
  const o = job as Record<string, unknown>;

  for (const k of ["response", "result", "output", "text", "message", "answer", "content"]) {
    const t = asText(o[k]);
    if (t) return t;
  }
  for (const k of ["result", "response", "data", "output"]) {
    const v = o[k];
    if (v && typeof v === "object") {
      const inner = extractText(v);
      if (inner) return inner;
    }
  }

  const msgs = o["messages"];
  if (Array.isArray(msgs)) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m || typeof m !== "object") continue;
      const c = (m as Record<string, unknown>)["content"];
      const t = asText(c);
      if (t) return t;
      if (Array.isArray(c)) {
        const parts: string[] = [];
        for (const p of c) {
          if (p && typeof p === "object") {
            const pt = asText((p as Record<string, unknown>)["text"]);
            if (pt) parts.push(pt);
          }
        }
        if (parts.length) return parts.join("\n");
      }
    }
  }
  return null;
}

export async function promptAgent(prompt: string): Promise<AgentResponse> {
  const key = agentKey();
  if (!key) return { ok: false, error: "Agent API is not configured." };

  const headers = { "Content-Type": "application/json", "X-API-Key": key };

  let jobId: string;
  try {
    const res = await timedFetch(
      `${BASE}/agent/prompt`,
      { method: "POST", headers, body: JSON.stringify({ prompt }) },
      REQUEST_TIMEOUT_MS,
    );
    if (!res.ok) {
      console.error(`[bankr-agent] submit ${res.status}`);
      return { ok: false, error: `Agent submit failed (${res.status}).` };
    }
    const data = (await res.json()) as { jobId?: string };
    if (!data?.jobId) return { ok: false, error: "Agent returned no job id." };
    jobId = data.jobId;
  } catch (err) {
    console.error("[bankr-agent] submit threw:", err instanceof Error ? err.message : err);
    return { ok: false, error: "Agent is unreachable." };
  }

  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const res = await timedFetch(`${BASE}/agent/job/${jobId}`, { headers }, REQUEST_TIMEOUT_MS);
      if (!res.ok) continue;
      const job = (await res.json()) as { status?: string };
      const status = String(job?.status ?? "").toLowerCase();
      if (status === "completed") {
        const text = extractText(job);
        return text ? { ok: true, text } : { ok: false, error: "Agent returned no readable text." };
      }
      if (status === "failed" || status === "cancelled") {
        return { ok: false, error: `Agent job ${status}.` };
      }
    } catch {
      // transient poll error — keep polling until the deadline
    }
  }
  return { ok: false, error: "Agent timed out." };
}
