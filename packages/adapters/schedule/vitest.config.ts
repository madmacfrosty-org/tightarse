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
        // Re-baselined when model classification was deleted. `autoUpdate` only
        // ever raises, so a denominator change has to be written by hand and
        // therefore has to carry its evidence.
        //
        // bedrock.ts, categorise.ts and classifier.ts went, taking 114 covered
        // lines with them. Measured on both sides: 3 uncovered lines and 1
        // uncovered function before, 3 and 1 after, over the same single file.
        // Nothing became uncovered — the remainder is simply a larger share of a
        // smaller total.
        //
        // What is left uncovered is handler.ts's Lambda `handler` body, which
        // constructs real AWS clients and cannot run in a unit test.
        lines: 95.65,
        functions: 80,
        branches: 100,
        statements: 95.65,
        autoUpdate,
      },
    },
  },
});