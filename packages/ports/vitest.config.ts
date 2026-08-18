import { defineConfig } from "vitest/config";
import { coverageBase, autoUpdate } from "@tightarse/vitest-config";

/**
 * Interfaces only. There is nothing to execute, so there is nothing to test.
 *
 * That is not a gap: the contract these declare is enforced by the compiler at
 * the adapter, which says `implements Transactions, Enrichments, …`. A runtime
 * test could not check it and a type-level one would have to depend on the
 * adapter, inverting the very direction this package exists to establish.
 *
 * Thresholds stay at zero rather than the package being excluded, so the day it
 * grows a function the number moves and somebody notices.
 */
export default defineConfig({
  test: {
    passWithNoTests: true,
    coverage: {
      ...coverageBase,
      thresholds: { lines: 0, functions: 0, branches: 0, statements: 0, autoUpdate },
    },
  },
});
