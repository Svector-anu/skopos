// Reads the Aeon fork's committed market reads and projects them to a concise,
// chat-ready string. The fork (a public GitHub Actions instance of aaronjmars/aeon)
// runs defi-overview + narrative-tracker on a cron and commits the output; Skopos
// fetches the raw file, so there is no runtime dependency on the Bankr Agent API.
//
// Aeon owns the read (regime + narratives); Skopos owns the live numbers. The
// projection is timestamped ("as of <date>") so it reads as a periodic snapshot,
// never as a live quote that could conflict with Skopos's own price sources.

const FORK = process.env.AEON_FORK_REPO?.trim() || "Svector-anu/skopos-aeon";
const raw = (path: string): string => `https://raw.githubusercontent.com/${FORK}/main/${path}`;

const TIMEOUT_MS = 8_000;
const TTL_MS = 15 * 60 * 1000;
const NEG_TTL_MS = 60 * 1000;

export type AeonKind = "defi" | "narrative";

interface CacheEntry {
  text: string | null;
  fetchedAt: number;
}
const cache = new Map<AeonKind, CacheEntry>();

async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(id);
  }
}

function extractDefi(md: string): string | null {
  const take = md.match(/^>\s*\*\*Take:\*\*\s*(.+)$/m)?.[1]?.trim();
  if (!take) return null;

  const date = md.match(/# Market Context \(as of ([\d-]+)\)/)?.[1] ?? "";

  const narrSection = md.split(/^## Active Narratives\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  const narratives = [...narrSection.matchAll(/^-\s*\*\*(.+?)\*\*\s*—\s*phase:\s*(\w+)/gm)]
    .slice(0, 5)
    .map((m) => `${m[1]} (${m[2]})`);

  const lines = [`DeFi read — ${take}`];
  if (narratives.length) lines.push(`Narratives: ${narratives.join(", ")}.`);
  lines.push(`— as of ${date || "today"} · powered by Aeon`);
  return lines.join("\n");
}

// narrative-tracker's committed output is already chat-formatted (it's the skill's
// own notification body: TRANSITIONS / REFLEXIVITY / POSITIONS / MAP). Pass it
// through with a light sanity gate and an attribution footer.
function extractNarrative(md: string): string | null {
  const body = md.trim();
  if (body.length < 30 || !/narrative/i.test(body)) return null;
  return `${body}\n— powered by Aeon`;
}

// Returns the concise read for a kind, or null when the fork hasn't produced one
// yet (callers fall back to their existing behavior). Successful reads cache for
// 15 min; misses cache for 60s so a transient failure recovers fast without
// hammering GitHub raw.
export async function getAeonRead(kind: AeonKind): Promise<string | null> {
  const cached = cache.get(kind);
  if (cached) {
    const ttl = cached.text ? TTL_MS : NEG_TTL_MS;
    if (Date.now() - cached.fetchedAt < ttl) return cached.text;
  }

  let text: string | null = null;
  if (kind === "defi") {
    const md = await fetchText(raw("memory/topics/market-context.md"));
    text = md ? extractDefi(md) : null;
  } else if (kind === "narrative") {
    const md = await fetchText(raw("output/.chains/narrative-tracker.md"));
    text = md ? extractNarrative(md) : null;
  }

  cache.set(kind, { text, fetchedAt: Date.now() });
  return text;
}
