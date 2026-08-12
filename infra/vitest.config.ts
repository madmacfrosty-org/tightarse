import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Infra is measured over lib/ and bin/ rather than src/, so it does not use
 * @tightarse/vitest-config. Thresholds are literal here so `autoUpdate` can
 * raise them as coverage lands.
 */
export default defineConfig({
  // Anchored to this directory rather than the working directory, so the
  // config behaves identically however it is invoked. `npx vitest run --config
  // infra/vitest.config.ts` from the repository root finds the same 31 tests.
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    // Synthesising five stacks is slower than a unit test, though not slow —
    // bundling is disabled in the harness.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      all: true,
      include: ["lib/**/*.ts", "bin/**/*.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: {
        lines: 89.4,
        functions: 78.5,
        branches: 88.5,
        statements: 89.4,
        autoUpdate: false,
      },
    },
  },
});
