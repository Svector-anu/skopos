import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The existing i18n test proves every t("…") key resolves. It does not prove
// the string's placeholders get values — so a message carrying {token} rendered
// the literal text "{token}" to the user, on the bracket banner of a quote card,
// which is the screen someone reads immediately before signing two signatures.
//
// The failure is invisible to a type checker and to a key-parity check, and it
// only shows up if a human happens to look at that exact card.

const ROOT = join(__dirname, "..", "..");
const SOURCE = "app/app/page.tsx";

type Usage = { namespace: string; key: string; hasParams: boolean; line: number };

/** Pairs each t("key", {...}?) with the useTranslations("ns") above it. */
function collectUsages(src: string): Usage[] {
  const lines = src.split("\n");
  const out: Usage[] = [];
  let ns = "";
  lines.forEach((line, i) => {
    const decl = line.match(/useTranslations\(\s*["'`]([^"'`]+)["'`]\s*\)/);
    if (decl) ns = decl[1];
    // t("key") or t("key", { … }) — the second arg is what we care about
    for (const m of line.matchAll(/\bt\(\s*["'`]([^"'`]+)["'`]\s*(,)?/g)) {
      out.push({ namespace: ns, key: m[1], hasParams: !!m[2], line: i + 1 });
    }
  });
  return out;
}

function resolve(tree: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined),
    tree,
  );
}

const messages = JSON.parse(readFileSync(join(ROOT, "messages", "en.json"), "utf8")) as Record<string, unknown>;
const usages = collectUsages(readFileSync(join(ROOT, SOURCE), "utf8"));

describe("i18n placeholders", () => {
  it("should collect usages at all", () => {
    // #given the source is read by regex, a guard against the scan silently
    // matching nothing and the real assertion below passing vacuously
    expect(usages.length).toBeGreaterThan(50);
  });

  it("should pass values for every message that interpolates", () => {
    // #given each t(...) call and the string it resolves to
    const unfilled = usages
      .filter(u => !u.hasParams)
      .filter(u => {
        const msg = resolve(messages, `${u.namespace}.${u.key}`);
        // ICU plural/select syntax is a different shape and is not what broke.
        return typeof msg === "string" && /\{[a-zA-Z_][\w]*\}/.test(msg);
      })
      .map(u => `${u.namespace}.${u.key} (${SOURCE}:${u.line})`);

    // #then none of them render a literal "{token}" to somebody about to sign
    expect(unfilled).toEqual([]);
  });
});
