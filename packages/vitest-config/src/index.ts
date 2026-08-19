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

/**
 * Opt-in, via `npm run coverage:pin`.
 *
 * This used to be `!process.env["CI"]` — on for every local run — and the result
 * was a ratchet that never ratcheted. Each run rewrote the thresholds in every
 * workspace, including the ones the change never touched, so `npm run
 * test:coverage` left a pile of modified config files indistinguishable from
 * noise. They got discarded, every time. CI could not save it either: rewriting a
 * config mid-run leaves a dirty tree and there is nothing there to commit to.
 *
 * Measured before changing it: six workspaces were sitting below what they
 * already achieved, services/api by eleven points. The floors had never once been
 * committed at their tightened value.
 *
 * So checking and tightening are now separate operations. `test:coverage` only
 * ever checks and leaves the tree clean; `coverage:pin` moves the floors, and you
 * commit that on purpose.
 */
export const autoUpdate = process.env["COVERAGE_PIN"] === "1";

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
    // A local development server whose logic is the deployed handler's. Agreed
    // excluded under the rule that only code containing no decision is exempt:
    // this one wires a port to a function that has its own tests.
    //
    // That justification was false when it was written. serve.ts had its own
    // copy of the routing — its own range defaults, its own path matching — so
    // it was excluded code containing decisions, and the two had drifted: it
    // honoured a `limit` parameter the deployed handler ignores. It calls
    // `route` now, so the exemption is earned rather than asserted.
    "src/serve.ts",
    // Command line entry points. Wiring only, by construction: the decisions
    // live in a sibling module that is imported and tested, and what remains is
    // reading environment variables and calling it. Same rule as serve.ts, and
    // the same pattern stryker already excludes from mutation.
    "src/**/*-cli.ts",
  ],
  reporter: ["text-summary", "json-summary"] as string[],
};
