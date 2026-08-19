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
        // Re-baselined when the two Lambda entry points moved between packages.
        //
        // NOT a relaxation of the standard, and worth the evidence because it looks
        // exactly like one: transform-handler.ts and reconcile-handler.ts were
        // diffed against their previous blobs and are byte-identical apart from an
        // import path. No test was removed or weakened and no file's own coverage
        // changed — the set of files in this package did, so a percentage over that
        // set is measuring something different from what it measured before.
        //
        // The uncovered remainder is Lambda `handler` bodies, which construct real
        // AWS clients and cannot run in a unit test; steps-handler.ts has sat at 0%
        // for the same reason. To earn these numbers back, cover connect.ts (71.8%)
        // and steps.ts (88.2%), which are uncovered on their merits.
        lines: 80.84,
        functions: 73.07,
        branches: 89.62,
        statements: 80.84,
        autoUpdate,
      },
    },
  },
});