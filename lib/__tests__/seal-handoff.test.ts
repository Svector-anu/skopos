import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A Seal take used to append to whatever chat /app restored on load — often an
// earlier unsigned quote card for the same order the Seal was published from.
// Two signable cards on one screen, and only one counted as a take: signing the
// older one placed a plain order that never reached the Seal page. Caught while
// running the two-wallet demo.
//
// Source-level because the page has no DOM harness. Crude, and it pins both
// halves: the fresh chat, and the delay that stops the restore overwriting it.

const PAGE = readFileSync(join(__dirname, "..", "..", "app", "app", "page.tsx"), "utf8");

function body(name: string): string {
  const start = PAGE.indexOf(`function ${name}(`);
  const next = PAGE.indexOf("\n  }\n", start);
  return PAGE.slice(start, next);
}

describe("seal handoff", () => {
  it("should open a take in a fresh chat rather than append to the last one", () => {
    // #then openSeal starts a new conversation before anything else
    const openSeal = body("openSeal");
    expect(openSeal).toContain("newChat();");
    expect(openSeal.indexOf("newChat();")).toBeLessThan(openSeal.indexOf("setMessages("));
  });

  it("should wait for the session restore before opening the take", () => {
    // #given /app restores the last conversation on mount
    // #then the take is deferred the same way the ?q= handoff is. firing first
    // would have the restore overwrite the fresh chat it just opened
    expect(PAGE).toContain("setTimeout(() => onSealRef.current(sealId, size), 150);");
    expect(PAGE).not.toMatch(/^\s*onSealRef\.current\(sealId, size\);/m);
  });
});
