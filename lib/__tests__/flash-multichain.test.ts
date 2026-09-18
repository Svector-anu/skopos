import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FLASH_ADVANCED_ORDER_CHAINS, FLASH_CHAIN_DISPLAY_NAME } from "@/app/api/chat/route";

// Flash was Robinhood-only when the quote card was written, and two things
// assumed it stayed that way after advanced orders reached eight more chains:
//
//   1. the card chose its signing component with `isRobinhoodOrigin`, so a
//      Flash order on Base was handed the Delora swap ladder, which cannot sign
//      it. Every non-Robinhood advanced order and every Base Seal was
//      unexecutable. The only orders that ever filled were on Robinhood Chain.
//   2. the post-success link was hardcoded to Robinhood's explorer, so a Base
//      order linked to the wrong chain the moment it succeeded.
//
// Neither was caught because nothing had ever been signed off Robinhood. These
// read the source because the card is a React component and this suite has no
// DOM — crude, and they pin the two assumptions that already broke once.

const PAGE = readFileSync(join(__dirname, "..", "..", "app", "app", "page.tsx"), "utf8");

function explorerKeys(): Set<string> {
  const start = PAGE.indexOf("const EXPLORER_URLS");
  const block = PAGE.slice(start, PAGE.indexOf("};", start));
  const keys = [...block.matchAll(/(?:"([^"]+)"|\b([A-Za-z][\w]*))\s*:\s*"https?:/g)]
    .map(m => m[1] ?? m[2]);
  return new Set(keys);
}

describe("flash across chains", () => {
  it("should route any Flash leg to the Flash signer, not just Robinhood's", () => {
    // #given the card's execute-component dispatch
    // #then it keys on the leg's shape. keying on the chain id is what left
    // every non-Robinhood order with a button that could not sign
    expect(PAGE).toContain(") : result.flash ? (");
    expect(PAGE).not.toMatch(/isRobinhoodOrigin\s*\?\s*\(/);
  });

  it("should not hardcode any one chain's explorer for a Flash order", () => {
    // #given the link recorded after a Flash order succeeds
    // #then it is derived from the order's chain
    expect(PAGE).not.toContain("explorerUrl: `https://robinhoodchain.blockscout.com/address/");
  });

  it("should have an explorer for every chain Flash orders can run on", () => {
    // #given the chains advanced orders reach
    const names = [...new Set(Object.values(FLASH_ADVANCED_ORDER_CHAINS))]
      .map(c => FLASH_CHAIN_DISPLAY_NAME[c])
      .filter((n): n is string => !!n);
    const keys = explorerKeys();

    // #then each one resolves to a link. a chain added to Flash without one
    // silently produces a relative, broken URL on the success screen
    expect(names.filter(n => !keys.has(n))).toEqual([]);
  });

  it("should actually find the explorer map", () => {
    // #given the map is read by regex, a guard against the scan matching
    // nothing and the assertion above passing vacuously
    expect(explorerKeys().size).toBeGreaterThan(20);
  });
});
