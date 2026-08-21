import { defineConfig } from "vitest/config";

// Unit tests for pure lib/ logic only — no DOM, no network, no Next runtime.
// Deliberately narrow: this exists so byte-exact, server-validated string
// construction (lib/flash.ts's update message) can be proven without a funded
// wallet, not as a general app test harness.
export default defineConfig({
  test: {
    include: ["lib/__tests__/**/*.test.ts"],
    environment: "node",
  },
});
