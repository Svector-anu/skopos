import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Flash refuses forceMinimalAllowance and attachedBracket in the same request:
//
//   VALIDATION_ERROR — "forceMinimalAllowance is not supported with attachedBracket"
//
// Sending it unconditionally broke every bracketed order — a protected entry
// failed to quote at all, which is worse than the unlimited approval the flag
// exists to avoid. The flag was verified against two wallets before shipping
// and both checks were on unbracketed orders, so the tested paths all passed
// while the untested one was the one that mattered.
//
// This reads the source rather than calling the resolver, because reaching
// resolveFlashOrderLeg means a live Flash call and this suite has no network.
// Crude, and it pins the one relationship that regressed.

const ROUTE = readFileSync(
  join(__dirname, "..", "..", "app", "api", "chat", "route.ts"),
  "utf8",
);

describe("flash quote request", () => {
  it("should leave exactly one unguarded use of the flag", () => {
    // #given two quote requests: the market swap, which cannot carry a bracket,
    // and the advanced order, which can
    const unguarded = ROUTE.split("\n      forceMinimalAllowance: true,").length - 1;

    // #then only the market one sets it outright. two would mean the bracketed
    // path is sending it again and every protected order fails to quote
    expect(unguarded).toBe(1);
  });

  it("should gate the flag on the absence of a bracket", () => {
    // #then the guard is specifically about the bracket, not some other
    // condition that happens to work today
    expect(ROUTE).toContain("...(order.bracket ? {} : { forceMinimalAllowance: true })");
  });

  it("should still ask for an exact allowance on the market swap path", () => {
    // #given resolveFlashLeg, which never carries a bracket
    // #then it keeps the flag — the fix narrows one call site, it does not
    // abandon exact allowances everywhere
    expect(ROUTE).toContain("orderType: \"market\",\n      funderAddress: senderAddress,\n      flashIntegratorFeeBps: FLASH_INTEGRATOR_FEE_BPS,\n      forceMinimalAllowance: true,");
  });
});
