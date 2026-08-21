import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Unit tests for pure logic only — no DOM, no network, no Next runtime.
// Deliberately narrow: this exists so byte-exact, server-validated string
// construction and parser boundaries can be proven without a funded wallet,
// not as a general app test harness.
export default defineConfig({
  // Mirrors tsconfig's "@/*" → "./*" so pure exports can be imported from
  // app/ (route.ts holds several parsers) without rewriting them as relative
  // paths that only the test would use.
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    include: ["lib/__tests__/**/*.test.ts"],
    environment: "node",
  },
});
