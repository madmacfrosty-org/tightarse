/**
 * Shared coverage settings, and the ratchet.
 *
 * Thresholds are NOT here. They are written out in each package's config as
 * literals, because `autoUpdate` rewrites them in place by editing the config
 * file, and it can only find them when they are literals in that file. The
 * trade is a little duplication for a ratchet that tightens itself as you work,
 * rather than one that depends on somebody remembering to raise it.
 *
 * A number is not the goal. Coverage measures which lines ran, not whether
 * anything was checked, and every expensive bug in this repository had the
 * failing line covered. Raise these with tests that would fail if the behaviour
 * were wrong — see docs/conventions/testing.md.
 */

/** Off in CI: a config that rewrites itself mid-run leaves a dirty tree. */
export const autoUpdate = !process.env["CI"];

export const coverageBase = {
  provider: "v8" as const,
  // Report on every source file, not only the ones a test happened to import.
  // Without this, deleting a test raises the percentage.
  all: true,
  include: ["src/**/*.ts"],
  exclude: [
    "src/**/*.test.ts",
    // Creates the table the integration tests run against. Test infrastructure
    // cannot meaningfully test itself.
    "src/create-test-table.ts",
  ],
  reporter: ["text-summary", "json-summary"] as string[],
};
