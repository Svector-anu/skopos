import { describe, expect, it } from "vitest";
import { escapeRegExp } from "@/lib/polymarket";

// getTopMarkets() interpolates a user-supplied Polymarket topic into a RegExp.
// Unescaped, an unbalanced "(" or a reversed range throws a SyntaxError at
// request time, and a crafted pattern becomes an attacker-supplied regex run
// against every market title fetched. These assert the escape holds for input
// that arrives straight from a chat message.

const buildPattern = (kw: string) => new RegExp(`\\b${escapeRegExp(kw)}\\b`, "i");

describe("polymarket topic escaping", () => {
  it("should not throw on regex metacharacters from a chat message", () => {
    // #given topics containing characters that are legal in a market name but
    // special in a regex
    const hostile = ["a(b", "[z-a]", "a{2,", "*", "+", "foo)bar", "\\"];

    // #when each is built into a filter pattern
    const build = () => hostile.map(buildPattern);

    // #then none throw — unescaped, "a(b" is an unterminated group and 500s
    expect(build).not.toThrow();
  });

  it("should match a metacharacter literally rather than as syntax", () => {
    // #given a topic containing a dot, which unescaped matches any character
    const pattern = buildPattern("a.c");

    // #when tested against a title the wildcard would wrongly match
    // #then only the literal form matches
    expect([pattern.test("a.c"), pattern.test("abc")]).toEqual([true, false]);
  });

  it("should not let a wildcard topic match every market", () => {
    // #given ".*", which unescaped matches everything
    const pattern = buildPattern(".*");

    // #then it matches nothing real — the filter cannot be turned into a
    // match-all by user text
    expect(pattern.test("Will Bitcoin hit $100k?")).toBe(false);
  });

  it("should still match ordinary topics", () => {
    // #given the shape users actually type
    const pattern = buildPattern("trump 2028");

    // #then real filtering is unaffected by the escaping
    expect(pattern.test("Will Trump 2028 happen?")).toBe(true);
  });
});
