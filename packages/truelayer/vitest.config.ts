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
        // Above where it started, by a different route than expected.
        //
        // The sync-window policy left for services/ingest, taking its seven tests
        // with it, and this fell 92.1 to 91.04 — not because anything became less
        // tested, but because a percentage over a smaller set of files is measuring
        // something else. Rather than re-baseline down, the gap it exposed got
        // covered: TrueLayerClient's request methods now have HTTP doubles, and the
        // number is higher than it was before the move.
        //
        // Functions stays low because the endpoint-spec predicates are data rather
        // than behaviour. What matters is that `get` and `token` are exercised —
        // the two that spend the rate-limit allowance and handle refresh tokens.
        lines: 95.52,
        functions: 61.11,
        branches: 92.3,
        statements: 95.52,
        autoUpdate,
      },
    },
  },
});