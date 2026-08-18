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
              // Lowered by 0.03-0.04 when the S3 handling moved to @tightarse/aws.
      // Nothing became less tested: the covered code left this package and is
      // covered at 100% where it landed, so the same uncovered lines are now a
      // fractionally larger share of a smaller denominator. This is the one case
      // where lowering is honest, and it is worth the comment because the rule
      // otherwise is that these only ever go up.
      lines: 82.04,
        functions: 71.42,
        branches: 90.62,
        statements: 82.04,
        autoUpdate,
      },
    },
  },
});