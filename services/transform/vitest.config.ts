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
      lines: 98.96,
        functions: 97.61,
        branches: 96.06,
        statements: 98.96,
        autoUpdate,
      },
    },
  },
});