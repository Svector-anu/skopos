// Reads the Aeon fork's committed market reads and projects them to concise,
// chat-ready strings. The fork (a public GitHub Actions instance of aaronjmars/aeon)
// runs defi-overview + narrative-tracker on a cron and commits the output; Skopos
// fetches the raw file, so there is no runtime dependency on the Bankr Agent API.
//
// defi / trending / protocols all come from the single market-context.md the
// defi-overview cron already produces, so surfacing them costs no extra cron runs.
//
// Aeon owns the read (regime, narratives, rankings); Skopos owns the live numbers.
// Projections are timestamped ("as of <date>") so they read as periodic snapshots,
// never as live quotes that could conflict with Skopos's own price sources.

const FORK = process.env.AEON_FORK_REPO?.trim() || "Svector-anu/skopos-aeon";
const rawUrl = (path: string): string => `https://raw.githubusercontent.com/${FORK}/main/${path}`;

const TIMEOUT_MS = 8_000;
const TTL_MS = 15 * 60 * 1000;
const NEG_TTL_MS = 60 * 1000;

const MARKET_CONTEXT = "memory/topics/market-context.md";
const NARRATIVE = "output/.chains/narrative-tracker.md";
const FEAR_DIVERGENCE = "output/.chains/fear-divergence.md";
const X402_MONITOR = "output/.chains/x402-monitor.md";

export type AeonKind = "defi" | "narrative" | "trending" | "protocols" | "fear" | "x402";

interface RawEntry {
  text: string | null;
  fetchedAt: number;
}
const rawCache = new Map<string, RawEntry>();

// Fetches a committed file with an in-memory cache: successes for 15 min, misses
// for 60s so a transient failure recovers fast without hammering GitHub raw. The
// same market-context.md is reused across the defi/trending/protocols reads.
async function fetchRaw(path: string): Promise<string | null> {
  const cached = rawCache.get(path);
  if (cached) {
    const ttl = cached.text ? TTL_MS : NEG_TTL_MS;
    if (Date.now() - cached.fetchedAt < ttl) return cached.text;
  }
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let text: string | null = null;
  try {
    const res = await fetch(rawUrl(path), { signal: controller.signal, cache: "no-store" });
    if (res.ok) text = await res.text();
  } catch {
    text = null;
  } finally {
    clearTimeout(id);
  }
  rawCache.set(path, { text, fetchedAt: Date.now() });
  return text;
}

function asOf(md: string): string {
  return md.match(/# Market Context \(as of ([\d-]+)\)/)?.[1] ?? "today";
}

// Pulls a "## <heading>…" section body from the markdown (up to the next "## ").
function section(md: string, headingPrefix: string): string {
  const re = new RegExp(`^##\\s+${headingPrefix}.*$`, "m");
  const start = md.search(re);
  if (start < 0) return "";
  const after = md.slice(start).replace(re, "");
  const next = after.search(/^## /m);
  return (next < 0 ? after : after.slice(0, next)).trim();
}

function bullets(body: string, n: number): string[] {
  return [...body.matchAll(/^-\s*(.+)$/gm)].slice(0, n).map((m) => m[1].trim());
}

function extractDefi(md: string): string | null {
  const take = md.match(/^>\s*\*\*Take:\*\*\s*(.+)$/m)?.[1]?.trim();
  if (!take) return null;
  const narr = section(md, "Active Narratives");
  const narratives = [...narr.matchAll(/^-\s*\*\*(.+?)\*\*\s*—\s*phase:\s*(\w+)/gm)]
    .slice(0, 5)
    .map((m) => `${m[1]} (${m[2]})`);

  // Split "regime — explanation" so the regime reads as a short bold headline
  // (the renderer bolds the first line) and the rest as plain supporting detail,
  // instead of one long run-on sentence.
  const dash = take.match(/^(.+?)\s*—\s*(.+)$/);
  const regime = dash ? dash[1].trim() : take;
  const detail = dash ? dash[2].trim() : "";

  const lines = [`DeFi read — ${regime}`];
  if (detail) lines.push(detail);
  if (narratives.length) {
    lines.push("", "**Narratives:**", ...narratives.map((n) => `- ${n}`));
  }
  lines.push("", `— as of ${asOf(md)} · powered by Aeon`);
  return lines.join("\n");
}

function extractTrending(md: string): string | null {
  const items = bullets(section(md, "Trending"), 5);
  if (!items.length) return null;
  return `Trending (CoinGecko), as of ${asOf(md)}:\n${items.map((i) => `• ${i}`).join("\n")}\n— powered by Aeon`;
}

function extractProtocols(md: string): string | null {
  const items = bullets(section(md, "Top DeFi Protocols"), 5);
  if (!items.length) return null;
  return `Top DeFi protocols by TVL, as of ${asOf(md)}:\n${items.map((i) => `• ${i}`).join("\n")}\n— powered by Aeon`;
}

// narrative-tracker's committed output is already chat-formatted (its own notify
// body: TRANSITIONS / REFLEXIVITY / POSITIONS / MAP), but it's written for
// Telegram — a *single-asterisk* bold title, and ALL-CAPS section labels with no
// markup at all. Upgrade both to **double-asterisk** bold so our renderer (which
// only recognizes **bold**) shows real section headers instead of flat text.
function extractNarrative(md: string): string | null {
  const body = md.trim();
  if (body.length < 30 || !/narrative/i.test(body)) return null;
  const structured = body
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      const telegramBold = t.match(/^\*([^*]+)\*$/);
      if (telegramBold) return `**${telegramBold[1]}**`;
      if (/^[A-Z][A-Z ]{2,24}$/.test(t)) return `**${t}**`;
      return line;
    })
    .join("\n");
  return `${structured}\n— powered by Aeon`;
}

// fear-divergence is conditional (only screens when Fear & Greed < 25) and often
// skips cleanly — that's a legitimate answer, not a missing read, so we surface
// the skip reason honestly rather than fabricating a signal that isn't there.
function extractFearDivergence(md: string): string | null {
  const body = md.trim();
  if (!body) return null;
  const isSkip = /skip path taken|No qualifying assets|No notification sent/i.test(body);
  if (isSkip) {
    const fng = body.match(/F&G:\s*(\d+)\s*\(([^)]+)\)/i);
    const btc7d = body.match(/BTC 7d:\s*\*{0,2}([+-][\d.]+%)\*{0,2}/i);
    const btc24h = body.match(/BTC 24h:\s*\*{0,2}([+-][\d.]+%)\*{0,2}/i);
    const parts = ["No fear-divergence signal right now."];
    if (fng) parts.push(`Fear & Greed is ${fng[1]} (${fng[2]})`);
    if (btc7d || btc24h) {
      const bits = [btc7d ? `BTC ${btc7d[1]} 7d` : null, btc24h ? `${btc24h[1]} 24h` : null].filter(Boolean).join(", ");
      parts.push(`but BTC is actually up (${bits}) — divergence needs BTC falling while other assets hold up, so there's nothing to screen for today.`);
    }
    return `${parts.join(" — ")}\n— powered by Aeon`;
  }
  const structured = body
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (/^[A-Z][A-Z ]{2,24}$/.test(t)) return `**${t}**`;
      return line;
    })
    .join("\n");
  return `${structured}\n— powered by Aeon`;
}

// x402-monitor's committed output is already chat-ready; drop the internal
// bookkeeping line and bold the standalone section labels (no inline content,
// unlike "momentum: breakout" which the renderer already handles as a label line).
function extractX402Monitor(md: string): string | null {
  const body = md.trim();
  if (!body) return null;
  const structured = body
    .split("\n")
    .filter((line) => !/^state:\s*memory\//i.test(line.trim()))
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.endsWith(":")) return `**${t}**`;
      return line;
    })
    .join("\n");
  return `${structured}\n— powered by Aeon`;
}

// Returns the concise read for a kind, or null when the fork hasn't produced one
// yet (callers fall back to their existing behavior).
export async function getAeonRead(kind: AeonKind): Promise<string | null> {
  if (kind === "narrative") {
    const md = await fetchRaw(NARRATIVE);
    return md ? extractNarrative(md) : null;
  }
  if (kind === "fear") {
    const md = await fetchRaw(FEAR_DIVERGENCE);
    return md ? extractFearDivergence(md) : null;
  }
  if (kind === "x402") {
    const md = await fetchRaw(X402_MONITOR);
    return md ? extractX402Monitor(md) : null;
  }
  const md = await fetchRaw(MARKET_CONTEXT);
  if (!md) return null;
  if (kind === "defi") return extractDefi(md);
  if (kind === "trending") return extractTrending(md);
  if (kind === "protocols") return extractProtocols(md);
  return null;
}

// The markdown extractors above target the app's card renderer (**bold**,
// "- " bullets). Plain-text consumers (headless text-mode, the paid API)
// strip it the same way — shared here so both stay in sync.
export function stripMarkdown(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^-\s+/gm, "• ");
}
