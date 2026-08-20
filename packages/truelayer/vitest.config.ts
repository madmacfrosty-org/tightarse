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
        // Nearly total, and it took becoming a real adapter to get here.
        //
        // The sync-window policy left for services/ingest and this fell 92.1 to
        // 91.04 — not because anything became less tested, but because a
        // percentage over a smaller set of files measures something else. Covering
        // TrueLayerClient's request methods with HTTP doubles took it to 95.52.
        //
        // Then the provider knowledge moved in: the URLs, the per-resource
        // endpoints, the dataset names and the classification of what TrueLayer
        // refuses, all of which services/ingest used to assert on through fake
        // paths. Testing it where it lives took functions from 61 to 100 — the
        // endpoint-spec predicates that were "data rather than behaviour" turn out
        // to be behaviour once something exercises them.
        lines: 99.08,
        functions: 100,
        branches: 92.53,
        statements: 99.08,
        autoUpdate,
      },
    },
  },
});