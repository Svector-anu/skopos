import { fetchWithTimeout } from "./http";

const READER_BASE = "https://r.jina.ai/";
const EXCERPT_CHARS = 600;

export interface WebContext {
  url: string;
  sourceHost: string;
  title: string;
  excerpt: string;
}

const URL_RE = /https?:\/\/[^\s<>"')]+/i;

export function extractUrl(text: string): string | null {
  return text.match(URL_RE)?.[0] ?? null;
}

function buildExcerpt(body: string): string {
  const cleaned = body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\(https?:\/\/[^)]*\)/g, "")
    .replace(/\[\d+\]/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`>|[\]]/g, "")
    .replace(/\n{2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > EXCERPT_CHARS ? `${cleaned.slice(0, EXCERPT_CHARS).trimEnd()}…` : cleaned;
}

// Targeting article/main gives clean extraction, but Jina returns 422 when the
// page has none of those elements (common on SPA landing pages). So try the
// targeted read first, then fall back to a full-page read.
async function readPage(url: string, targeted: boolean): Promise<string | null> {
  const headers: Record<string, string> = { Accept: "text/plain" };
  if (targeted) headers["X-Target-Selector"] = "article, main, #mw-content-text";
  let res: Response;
  try {
    res = await fetchWithTimeout(`${READER_BASE}${url}`, { headers });
  } catch {
    return null;
  }
  if (!res.ok) {
    console.error(`[intel] reader error ${res.status}${targeted ? " (targeted)" : ""}`);
    return null;
  }
  const raw = await res.text();
  return raw.trim().length > 0 ? raw : null;
}

export async function fetchWebContext(url: string): Promise<WebContext | null> {
  let host: string;
  try {
    host = new URL(url).host.replace(/^www\./, "");
  } catch {
    return null;
  }

  const raw = (await readPage(url, true)) ?? (await readPage(url, false));
  if (!raw) return null;

  const title = raw.match(/^Title:\s*(.+)$/m)?.[1]?.trim() || host;
  const bodyStart = raw.indexOf("Markdown Content:");
  const body = bodyStart >= 0 ? raw.slice(bodyStart + "Markdown Content:".length) : raw;
  const excerpt = buildExcerpt(body);
  if (excerpt.length === 0) return null;

  return { url, sourceHost: host, title, excerpt };
}
