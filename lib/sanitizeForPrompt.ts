// Strips control characters (the actual injection-payload vector — embedded
// newlines, null bytes, escape sequences) and caps length before an
// externally-sourced string (on-chain token metadata, DeFiLlama pool names)
// reaches an LLM prompt as free-form content.
export function sanitizeForPrompt(s: string, maxLen = 40): string {
  return s.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, maxLen);
}
