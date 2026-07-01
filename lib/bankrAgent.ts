// Bankr Agent API client. Skopos sends a natural-language prompt to a Bankr agent
// that has the Aeon skills installed; the agent runs the skill and returns text.
//
// Reads take 50-70s (measured), which exceeds serverless function limits, so the
// work is split: the server SUBMITS (fast) and the CLIENT polls the job. Gated on
// BANKR_AGENT_KEY (a bk_ Agent API key); unset → the Aeon reads aren't offered.
// Separate from BANKR_LLM_KEY (the Smart-tier text gateway).

const BASE = "https://api.bankr.bot";
const REQUEST_TIMEOUT_MS = 12_000;

export interface SubmitResult {
  ok: boolean;
  jobId?: string;
  error?: string;
}

export type JobStatus = "pending" | "completed" | "failed" | "cancelled" | "unknown";

export interface JobResult {
  ok: boolean;
  status: JobStatus;
  text?: string;
  error?: string;
}

// Bankr job ids look like `job_J3WHLF6V94SGPR2C`. Validate before interpolating
// into the poll URL so a crafted id can't reshape the request path (SSRF guard).
const JOB_ID_RE = /^job_[A-Za-z0-9]+$/;
export function isJobId(v: unknown): v is string {
  return typeof v === "string" && JOB_ID_RE.test(v);
}

function agentKey(): string | null {
  const k = process.env.BANKR_AGENT_KEY?.trim();
  return k && k.startsWith("bk_") ? k : null;
}

export function aeonEnabled(): boolean {
  return agentKey() !== null;
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

export async function submitAgentPrompt(prompt: string): Promise<SubmitResult> {
  const key = agentKey();
  if (!key) return { ok: false, error: "Agent API is not configured." };

  const headers = { "Content-Type": "application/json", "X-API-Key": key };
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
    if (!isJobId(data?.jobId)) return { ok: false, error: "Agent returned no job id." };
    return { ok: true, jobId: data.jobId };
  } catch (err) {
    console.error("[bankr-agent] submit threw:", err instanceof Error ? err.message : err);
    return { ok: false, error: "Agent is unreachable." };
  }
}

export async function pollAgentJob(jobId: string): Promise<JobResult> {
  const key = agentKey();
  if (!key) return { ok: false, status: "unknown", error: "Agent API is not configured." };
  if (!isJobId(jobId)) return { ok: false, status: "unknown", error: "Invalid job id." };

  const headers = { "X-API-Key": key };
  try {
    const res = await timedFetch(`${BASE}/agent/job/${jobId}`, { headers }, REQUEST_TIMEOUT_MS);
    if (!res.ok) return { ok: false, status: "unknown", error: `Job check failed (${res.status}).` };
    const job = (await res.json()) as { status?: string };
    const status = String(job?.status ?? "").toLowerCase();
    if (status === "completed") {
      const text = extractText(job);
      return text
        ? { ok: true, status: "completed", text }
        : { ok: false, status: "completed", error: "Agent returned no readable text." };
    }
    if (status === "failed" || status === "cancelled") {
      return { ok: false, status, error: `Agent job ${status}.` };
    }
    return { ok: true, status: "pending" };
  } catch {
    return { ok: false, status: "unknown", error: "Job check failed." };
  }
}
