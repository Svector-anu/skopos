import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { useTypewriter } from "@/hooks/useTypewriter";

const commands = [{ cmd: "swap 1 eth", response: "route ready" }];

function Probe() {
  const state = useTypewriter(commands);
  return React.createElement("div", { "data-phase": state.phase }, `${state.userText}|${state.aiText}`);
}

describe("useTypewriter reduced-motion hydration", () => {
  it("matches the server render", () => {
    const originalWindow = globalThis.window;
    delete (globalThis as { window?: unknown }).window;
    try {
      const server = renderToString(React.createElement(Probe));

      (globalThis as { window?: unknown }).window = {
        matchMedia: () => ({
          matches: true,
          addEventListener() {},
          removeEventListener() {},
        }),
      };
      const clientInitial = renderToString(React.createElement(Probe));

      console.log({ server, clientInitial });
      expect(clientInitial).toBe(server);
    } finally {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });
});
