// Shared by lib/parseIntent.ts (chat system prompt directive) and
// i18n/request.ts (next-intl UI strings) — dependency-free so the i18n config
// module doesn't have to pull in the Groq/LLM stack just to detect a locale.
//
// Phase 1/2 of localization: zh/vi only, auto-detected from the browser's
// Accept-Language header, no manual toggle. Everything else stays English —
// undefined means "no supported locale detected", not "default to some other
// language".
export type SupportedLocale = "zh" | "vi";
const SUPPORTED_LOCALES = new Set<SupportedLocale>(["zh", "vi"]);

export function detectLocale(acceptLanguage: string | null | undefined): SupportedLocale | undefined {
  if (!acceptLanguage) return undefined;
  for (const part of acceptLanguage.split(",")) {
    const tag = part.trim().split(";")[0]?.split("-")[0]?.toLowerCase();
    if (tag && SUPPORTED_LOCALES.has(tag as SupportedLocale)) return tag as SupportedLocale;
  }
  return undefined;
}
