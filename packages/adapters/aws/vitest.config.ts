import { defineConfig } from "vitest/config";
import { coverageBase, autoUpdate } from "@tightarse/vitest-config";

export default defineConfig({
  test: {
    coverage: {
      ...coverageBase,
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100, autoUpdate },
    },
  },
});
