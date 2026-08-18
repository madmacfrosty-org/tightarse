import { defineConfig } from "vitest/config";
import { coverageBase, autoUpdate } from "@tightarse/vitest-config";

// Thresholds are literal here so `autoUpdate` can raise them as coverage lands;
// it rewrites this file and can only find them written out. Raise them, never
// lower them.
//
// **Branches must be pinned from a CI run, not from a local one.** This package
// is the exception to `autoUpdate` being trustworthy, because its numbers depend
// on which store the integration tests ran against and the two do not agree:
// the same suite takes different paths on DynamoDB Local and on real DynamoDB.
//
// It is not reliably the direction you would guess. The emulator was assumed to
// be the lower of the two — 79.03% against 81.2% when this was first measured —
// and a threshold raised from an emulator run at 82.66% then failed CI at
// 80.82%, breaking main. Conditional writes and transactions are where the two
// diverge, so which store scores higher moves with whatever the suite last
// exercised.
//
// The consequence to watch: running `test:coverage` locally against the
// emulator will try to raise `branches` back above what CI achieves, and
// committing that reintroduces exactly this failure. If autoUpdate raises this
// number on your machine, check it against the last CI run before committing.
// The other three metrics do not have this problem.
export default defineConfig({
  test: {
    coverage: {
      ...coverageBase,
      thresholds: {
        lines: 73.93,
        functions: 69.44,
        branches: 80.8,
        statements: 73.93,
        autoUpdate,
      },
    },
  },
});