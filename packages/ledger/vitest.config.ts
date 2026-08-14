import { defineConfig } from "vitest/config";
import { coverageBase, autoUpdate } from "@tightarse/vitest-config";

// Thresholds are literal here so `autoUpdate` can raise them as coverage lands;
// it rewrites this file and can only find them written out. Raise them, never
// lower them.
//
// This package's numbers depend on which store the integration tests ran
// against, and the two do not agree: the same suite took different paths on
// DynamoDB Local and on real DynamoDB, 79.03% branch coverage versus 81.2%.
// CI runs against real DynamoDB and a laptop usually runs against the emulator,
// so a threshold raised locally is raised from the lower of the two — safe in
// that direction, and the reason not to trust a local `autoUpdate` here as
// proof that CI will pass. If this package ever fails its thresholds in CI
// alone, that difference is the first thing to check.
export default defineConfig({
  test: {
    coverage: {
      ...coverageBase,
      thresholds: {
        lines: 73.93,
        functions: 69.44,
        branches: 82.66,
        statements: 73.93,
        autoUpdate,
      },
    },
  },
});