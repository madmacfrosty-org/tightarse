import { defineConfig } from "vitest/config";
import { coverageBase, autoUpdate } from "@tightarse/vitest-config";

// Thresholds are literal here so `autoUpdate` can raise them as coverage lands;
// it rewrites this file and can only find them written out. Raise them, never
// lower them.
export default defineConfig({
  test: {
    coverage: {
      ...coverageBase,
      thresholds: {
        lines: 75.36,
        functions: 47.61,
        branches: 100.0,
        statements: 75.36,
        autoUpdate,
      },
    },
  },
});