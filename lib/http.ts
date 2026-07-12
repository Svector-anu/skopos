// Shared timeout wrapper for external fetches. Every lib/ integration was
// independently reimplementing this exact AbortController+setTimeout pattern
// (10 copies, found in a full repo audit) — this is the one copy everything
// else imports. Default 8s matches CLAUDE.md's documented "all external
// fetches use an 8s timeout" — two callers (`polymarket-bridge.ts`,
// `defillama.ts`) had drifted to 10s with no stated reason; both now use the
// same 8s default like every other source instead of a silently-different one.
export async function fetchWithTimeout(
  input: string,
  init?: RequestInit,
  timeoutMs = 8000,
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}
