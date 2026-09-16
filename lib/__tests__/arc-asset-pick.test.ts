import { describe, expect, it } from "vitest";
import { pickArcAsset, ARC_USDC_ADDRESS, type FlashSearchAsset } from "@/lib/flash";

// Arc launched today and its asset index is ALREADY full of impersonators.
// These fixtures are not invented — they are what Flash's own /search returned
// for chain=arc on 2026-09-16: four tokens calling themselves USDC, two CRCL,
// three PEG, and a "USD//COIN" sitting next to the real "USDC".
//
// resolveArcToken pins USDC by address so it never reaches this function. But
// everything else on the chain does, and picking wrong here puts someone's
// money into a contract that merely shares a ticker with what they asked for.

const asset = (o: Partial<FlashSearchAsset>): FlashSearchAsset => ({
  chain: "arc", address: "0x" + "0".repeat(40), symbol: "X", name: "X",
  decimals: 18, liquidity: "50000", volume24h: "1000", riskFlagged: false, ...o,
});

// Real rows, real addresses, real liquidity figures.
const REAL_USDC   = asset({ symbol: "USDC", address: ARC_USDC_ADDRESS, liquidity: "763438", decimals: 6 });
const FAKE_USDC_1 = asset({ symbol: "USDC", address: "0x8e98a62a995a50eca9979bfa016f91bf36a8f9d9", liquidity: "155355" });
const FAKE_USDC_2 = asset({ symbol: "USDC", address: "0xb67f50fde86e09b5da963c4251cbd4788b151ed5", liquidity: "136095" });
const USD_COIN    = asset({ symbol: "USD//COIN", address: "0x1FD0f176B619fe96D13006B558AF97469Ac56667", liquidity: "6556" });
const CIRBTC      = asset({ symbol: "cirBTC", address: "0x171A4217b86A807A64eB94757Db6849fb4bDbAA0", liquidity: "5464999" });

describe("pickArcAsset", () => {
  it("should require an exact symbol match", () => {
    // #given a search for USD, where the chain carries "USD//COIN"
    // #when an asset is picked
    const picked = pickArcAsset([USD_COIN], "USD");

    // #then nothing matches. a near-miss is how an impersonator gets chosen,
    // and this chain ships with one on day one
    expect(picked).toBeNull();
  });

  it("should refuse an asset Flash itself flags as risky", () => {
    // #given the deepest book on the chain, flagged
    const flagged = asset({ symbol: "COOL", liquidity: "9999999", riskFlagged: true });

    // #then depth does not buy its way past the flag
    expect(pickArcAsset([flagged], "COOL")).toBeNull();
  });

  it("should refuse a book too thin to fill against", () => {
    // #given a token below the liquidity floor
    const dust = asset({ symbol: "GIZMO", liquidity: "300" });

    // #then it is not resolvable — a quote against it would be a worse answer
    // than no answer
    expect(pickArcAsset([dust], "GIZMO")).toBeNull();
  });

  it("should take the deepest book among same-symbol tokens", () => {
    // #given the three real USDC entries in Flash's Arc index, shuffled so
    // response order cannot be what decides it
    const picked = pickArcAsset([FAKE_USDC_2, REAL_USDC, FAKE_USDC_1], "USDC");

    // #then the deepest wins. that is a heuristic, not proof — which is exactly
    // why resolveArcToken pins USDC by address and never calls this for it
    expect(picked?.address).toBe(ARC_USDC_ADDRESS);
  });

  it("should not pick an asset from another chain", () => {
    // #given the same symbol on a different chain in the response
    const offChain = asset({ symbol: "cirBTC", chain: "base", liquidity: "9999999" });

    // #when Arc is asked for
    const picked = pickArcAsset([offChain, CIRBTC], "cirBTC");

    // #then the Arc one is returned, whatever the other's depth
    expect(picked?.address).toBe(CIRBTC.address);
  });

  it("should match case-insensitively on the caller's side", () => {
    // #given Arc's real cirBTC, whose symbol is mixed case
    // #when the caller upper-cased the query, as resolveArcToken does
    const picked = pickArcAsset([CIRBTC], "CIRBTC");

    // #then it still resolves — otherwise "buy cirbtc" would find nothing
    expect(picked?.address).toBe(CIRBTC.address);
  });

  it("should return null for an empty index rather than guessing", () => {
    expect(pickArcAsset([], "ANYTHING")).toBeNull();
  });
});
