const READER_BASE = "https://r.jina.ai/";
const TIMEOUT_MS   = 8000;
const EXCERPT_CHARS = 600;

async function fetchWithTimeout(input: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

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

export async function fetchWebContext(url: string): Promise<WebContext | null> {
  let host: string;
  try {
    host = new URL(url).host.replace(/^www\./, "");
  } catch {
    return null;
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(`${READER_BASE}${url}`, {
      headers: {
        Accept: "text/plain",
        "X-Target-Selector": "article, main, #mw-content-text",
      },
    });
  } catch {
    return null;
  }

  if (!res.ok) {
    console.error(`[intel] reader error ${res.status}`);
    return null;
  }

  const raw = await res.text();
  if (raw.trim().length === 0) return null;

  const title = raw.match(/^Title:\s*(.+)$/m)?.[1]?.trim() || host;
  const bodyStart = raw.indexOf("Markdown Content:");
  const body = bodyStart >= 0 ? raw.slice(bodyStart + "Markdown Content:".length) : raw;
  const excerpt = buildExcerpt(body);
  if (excerpt.length === 0) return null;

  return { url, sourceHost: host, title, excerpt };
}
