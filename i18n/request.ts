import { getRequestConfig } from "next-intl/server";
import { headers } from "next/headers";
import { detectLocale } from "@/lib/locale";

// No i18n routing — no [locale] segments, no proxy/middleware, no URL
// changes. Locale is resolved once per request straight from the browser's
// Accept-Language header (zh/vi only; anything else falls back to en) and
// handed to Server/Client Components via NextIntlClientProvider in
// app/layout.tsx.
export default getRequestConfig(async () => {
  const acceptLanguage = (await headers()).get("accept-language");
  const locale = detectLocale(acceptLanguage) ?? "en";

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
