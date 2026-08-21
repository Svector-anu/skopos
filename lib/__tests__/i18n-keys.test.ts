import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A locale-parity check that only compares en/zh/vi to each other passes
// happily when a key is in the WRONG namespace in all three — which is
// exactly what shipped: approveProtection / signBothAndExecute /
// permitFlowUnsupported sat under app.quote while FlashExecuteButton reads
// app.flash, so both new bracket buttons would have rendered next-intl's raw
// key path in every language.
//
// This resolves each t("…") against the namespace its own component declares.

const ROOT = join(__dirname, "..", "..");

function loadLocale(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, "messages", `${locale}.json`), "utf8"));
}

function resolve(tree: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined),
    tree,
  );
}

/**
 * Pairs every `t("key")` with the `useTranslations("ns")` that precedes it.
 * Source-order scoping is an approximation of lexical scope, but it matches
 * how this file is written — one `const t = useTranslations(...)` per
 * component, and components do not nest.
 */
function collectKeyUsages(source: string): { namespace: string; key: string; line: number }[] {
  const out: { namespace: string; key: string; line: number }[] = [];
  let namespace: string | null = null;
  source.split("\n").forEach((text, i) => {
    const ns = /useTranslations\(\s*"([^"]+)"\s*\)/.exec(text);
    if (ns) namespace = ns[1];
    if (!namespace) return;
    for (const m of text.matchAll(/\bt\(\s*"([^"]+)"/g)) {
      // Template keys (t(`status.${x}`)) can't be resolved statically.
      if (!m[1].includes("${")) out.push({ namespace, key: m[1], line: i + 1 });
    }
  });
  return out;
}

const SOURCES = ["app/app/page.tsx"];

describe("i18n keys", () => {
  const en = loadLocale("en");
  const usages = SOURCES.flatMap(f => collectKeyUsages(readFileSync(join(ROOT, f), "utf8")));

  it("should find translation usages to check", () => {
    // #given the client source files
    // #when their t() calls are collected
    // #then there are some — a zero here would make every assertion vacuous
    expect(usages.length).toBeGreaterThan(50);
  });

  it("should resolve every key in the namespace its own component declares", () => {
    // #given each t("key") paired with its useTranslations("ns")
    // #when each is resolved against en.json
    const unresolved = usages
      .filter(u => typeof resolve(en, `${u.namespace}.${u.key}`) !== "string")
      .map(u => `${u.namespace}.${u.key} (page.tsx:${u.line})`);

    // #then none are missing — a key in the wrong namespace renders as its
    // own raw path to the user
    expect(unresolved).toEqual([]);
  });

  it("should carry the identical key set in every locale", () => {
    // #given the flattened key paths of each locale
    const flatten = (node: unknown, prefix = ""): string[] =>
      node && typeof node === "object"
        ? Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
            typeof v === "object" && v !== null ? flatten(v, `${prefix}${k}.`) : [`${prefix}${k}`])
        : [];
    const base = new Set(flatten(en));

    // #when zh and vi are compared against en
    const drift = (["zh", "vi"] as const).flatMap(loc => {
      const keys = new Set(flatten(loadLocale(loc)));
      return [
        ...[...base].filter(k => !keys.has(k)).map(k => `${loc} missing ${k}`),
        ...[...keys].filter(k => !base.has(k)).map(k => `${loc} extra ${k}`),
      ];
    });

    // #then neither has drifted from en
    expect(drift).toEqual([]);
  });
});
