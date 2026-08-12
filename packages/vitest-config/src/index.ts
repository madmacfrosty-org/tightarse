import { defineConfig, type UserConfig } from "vitest/config";

/**
 * Shared test configuration and the coverage ratchet.
 *
 * Thresholds are pinned at whatever each package achieves today, not at an
 * aspirational number. That makes them a ratchet: coverage cannot fall, and
 * every new untested branch fails the build in the package that added it.
 * `thresholds.autoUpdate` is deliberately OFF — a threshold that rewrites
 * itself downwards is not a threshold.
 *
 * A number is not the goal. Coverage measures which lines ran, not whether
 * anything was checked, and every expensive bug in this repository had the
 * failing line covered: the card sign inversion, the month-end overflow in
 * historyFrom, the rounding boundary in toMinorUnits. Each ran under a passing
 * test that asserted the implementation rather than the requirement. Raise
 * these numbers with tests that would fail if the behaviour were wrong — see
 * docs/conventions/testing.md.
 */
export interface PackageCoverage {
  lines: number;
  functions: number;
  branches: number;
  statements: number;
}

export function testConfig(thresholds: PackageCoverage): UserConfig {
  return defineConfig({
    test: {
      coverage: {
        provider: "v8",
        // Report on every source file, not only the ones a test happened to
        // import. Without this, deleting a test *raises* the percentage.
        all: true,
        include: ["src/**/*.ts"],
        exclude: [
          "src/**/*.test.ts",
          // Creates the table the integration tests run against. Test
          // infrastructure cannot meaningfully test itself.
          "src/create-test-table.ts",
        ],
        reporter: ["text-summary", "json-summary"],
        thresholds: { ...thresholds, autoUpdate: false },
      },
    },
  }) as UserConfig;
}
