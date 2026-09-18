import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The approval scanner is triggered by a regex in the chat route rather than by
// an exported function, so this reads the literal pattern out of the source.
// Ugly, and better than not testing the thing a first-time user types.
//
// The phrasing that prompted this: "is my approval unlimited?" — the example in
// a partner writeup that sends new people to Skopos. It matched nothing, so the
// people most likely to type it were the people least likely to know it had
// failed. They got a generic LLM reply pointing them at their portfolio.

function approvalScanRe(): RegExp {
  const src = readFileSync(join(__dirname, "..", "..", "app", "api", "chat", "route.ts"), "utf8");
  const line = src.split("\n").find(l => l.includes("const APPROVAL_SCAN_RE"));
  if (!line) throw new Error("APPROVAL_SCAN_RE not found in route.ts");
  const body = line.slice(line.indexOf("/") + 1, line.lastIndexOf("/i"));
  return new RegExp(body, "i");
}

const RE = approvalScanRe();

describe("approval scan phrasing", () => {
  it.each([
    "is my approval unlimited?",
    "are my approvals unlimited",
    "do i have any unlimited approvals",
    "is my allowance unlimited",
    "any risky approvals on my wallet",
    "check my approvals",
    "scan my wallet for risky approvals",
    "revoke my approvals",
    "unlimited approvals",
  ])("should route %j to the scanner", (phrase) => {
    // #given a phrasing a real person would type
    // #then it reaches the approval scanner rather than the LLM fallback
    expect(RE.test(phrase)).toBe(true);
  });

  it.each([
    "swap 1 eth to usdc",
    "what is an approval",
    "eth price",
    "show my portfolio",
  ])("should leave %j alone", (phrase) => {
    // #given a message with no approval intent
    // #then the scanner does not claim it — a false positive here costs a real
    // multi-chain log scan and answers a question nobody asked
    expect(RE.test(phrase)).toBe(false);
  });
});
