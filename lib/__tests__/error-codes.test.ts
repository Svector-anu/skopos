import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST, resolveFlashLeg, resolveLeg, resolveRelayLeg } from "@/app/api/chat/route";

async function ask(message: string) {
  const request = new NextRequest("https://www.tryskopos.xyz/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `test-${message}` },
    body: JSON.stringify({ message }),
  });
  return POST(request).then((response) => response.json());
}

describe("typed chat error codes", () => {
  it("marks a wallet-gated command without relying on its copy", async () => {
    const response = await ask("show my payments");

    expect(response).toMatchObject({ type: "error", code: "wallet_required" });
    expect(response.text).toEqual(expect.any(String));
  });

  it.each([
    ["Delora", resolveLeg],
    ["Flash", resolveFlashLeg],
    ["Relay", resolveRelayLeg],
  ] as const)("marks the %s execution guard before making a quote", async (_name, resolve) => {
    const result = await resolve({
      originChain: "base",
      destinationChain: "arbitrum",
      token: "USDC",
      amount: "10",
      destinationToken: "USDC",
    });

    expect(result).toMatchObject({ ok: false, code: "wallet_required" });
  });
});
