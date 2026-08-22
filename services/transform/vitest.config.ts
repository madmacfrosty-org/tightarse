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
        // Re-baselined twice now, both times because the set of files changed
        // rather than the testing. `autoUpdate` cannot express this: it only ever
        // raises, so a genuine denominator change has to be written by hand, and
        // therefore has to carry its evidence.
        //
        // First: the two Lambda entry points moved between packages —
        // transform-handler.ts and reconcile-handler.ts diffed byte-identical
        // apart from an import path.
        //
        // Second: reconcile.ts and reconcile-phase.ts left for @tightarse/domain,
        // taking 97 fully-covered lines with them. Measured on both sides of the
        // move, the uncovered totals are unchanged — 10 lines, 4 functions and 7
        // branches before and after — and the partial files are the same four.
        // Nothing became uncovered; a smaller denominator made the fixed
        // remainder a larger share of it. The code that left is now under the
        // domain's 100% floor, which is stricter than this one.
        //
        // The uncovered remainder is Lambda `handler` bodies, which construct real
        // AWS clients and cannot run in a unit test; steps-handler.ts has sat at 0%
        // for the same reason. To earn these numbers back, cover the remaining
        // branch in transform.ts, which is uncovered on its merits.
        lines: 97.83,
        functions: 90,
        branches: 96.81,
        statements: 97.83,
        autoUpdate,
      },
    },
  },
});
