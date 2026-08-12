# Testing conventions

Every rule below exists because of a specific failure in this repository. None
is general advice, and none should be kept if the reason for it stops being
true.

[test-strategy.md](test-strategy.md) covers *where* a test belongs — the funnel
from unit tests down to canaries. This file is about *how* to write one.

See also [CONTRIBUTING](../../CONTRIBUTING.md) for the wider conventions, and
[the fixtures rule](../../CONTRIBUTING.md#this-repository-is-public), which is
where test data must come from and why.

**A regression test must fail against the bug.** Reinstate the defect, watch the
test go red, then remove it again. The first version of the card-sign regression
test passed with the bug reinstated — the suite had failed to *load* on a
missing build, and "17 passed" was printed by the tests that did run. A test you
have not seen fail is a test you have not written.

**Test the code that ships, not a copy of it.** Where logic is hard to reach —
inside a handler, behind a client — extract it and test the extraction, as
`selectConnections` is. A test that reimplements the rule in the test file
passes forever while the real code rots.

**Assert what the code should do, not what it does.** Two bugs here were written
and then enshrined in a passing test: a month-end overflow in `historyFrom`, and
a rounding boundary in `toMinorUnits`. Writing the test after the implementation
by reading the implementation proves only that you read it.

**Cover the seams.** The card sign inversion lived between `mapTransaction`,
`detectTransfers` and `summarise`. Every one of them was self-consistent and
every unit test passed; the ledger was still wrong by £40k in each direction.
`sign-regression.test.ts` deliberately spans all three.

**Fixtures reproduce the provider's quirks.** See above — a tidy fixture would
have ratified the sign bug rather than caught it.

**Pin the clock.** A test that derives both "now" and an expiry from
`Date.now()` passes until it doesn't.

**Test files are not typechecked.** `tsconfig` excludes `src/**/*.test.ts`, so
the compiler will not catch a wrong shape in a test. A test once passed rows
with no `dedupKey` into the transfer detector; they collided on `undefined` and
the whole ledger was skipped as a single transfer. The types forbade it and
nothing was checking. Be more careful in tests than in source, not less.

**Integration tests are self-contained.** `ledger.integration.test.ts` has
several `suite()` blocks and each owns its client and its cleanup — a `ledger`
declared in one is not visible in another. Sweep your own rows, and note that
member rows live outside the tenant partition, so a sweep by partition misses
them.

Integration tests run against DynamoDB Local and skip without it:

```sh
LEDGER_TEST_TABLE=Ledger LEDGER_TEST_ENDPOINT=http://localhost:8000 npm test
```

CI always sets both, so they always run there. Ten of them skipped silently on
every push for weeks, which is a green tick that means nothing.

**Read the whole test output, not the summary line.** `npm test` prints a
per-workspace "N passed" that stays green while an entire suite fails to
collect. The runner's exit code is honest; the line above it is not always.

## Where coverage is thin

Pure logic is well covered and the wiring is not: handlers, CLIs and anything
touching AWS or TrueLayer are close to 0%. `services/ingest/src/steps.ts` is the
one that matters — it spends the rate limit and decides what to fetch, and a
mistake there costs a bank consent rather than a test run. `infra/` has no tests
at all, and almost every incident this project has had was infrastructure: two
IAM condition-key mistakes, an unmapped Cognito attribute that refused every
sign-in, a lifecycle rule whose expiry preceded its transition. `cdk synth`
passes on all of those.

## Coverage, and why it is not the goal

Each package pins coverage thresholds at what it achieves today
(`vitest.config.ts`, using `@tightarse/vitest-config`). They are a **ratchet**:
coverage cannot fall, and new untested code fails the build in the package that
added it. Raise them as you go; never lower them.

`npm test` runs plain and fast. `npm run test:coverage` enforces the thresholds,
and CI runs that.

Coverage answers "did this line run", never "did anything check the result".
Every expensive bug in this repository had its failing line covered. So a
package at 100% lines is a package where the tests are *capable* of catching a
regression, not one where they will.

## Mutation testing

`npm run test:mutation` changes the source in small ways — flips a comparison,
swaps a string, forces a condition — and reports which changes your tests failed
to notice. A surviving mutant is a line that runs under a test that would not
have complained if it were wrong.

Run it on the package you are working in; it is far slower than the test suite
and does not belong on every push.

It is worth the time because it finds precisely what coverage hides. `map.ts`
was fully line-covered and still scored 85%, with eight survivors:

```
[Survived] institutionName: raw.provider?.display_name ?? "unknown"   → ""
[Survived] displayName: raw.display_name ?? raw.account_id            → left side only
[Survived] provider: "truelayer"                                      → ""
[Survived] ...(raw.current !== undefined ? { current } : {})          → always true
[NoCoverage] ...(raw.merchant_name ? { merchantName } : {})
```

Every one is real. The mapper could have dropped merchant names, renamed the
provider on every row in the ledger, or turned "unknown" into an empty string
that reads like a name the bank supplied — and the suite stayed green. Writing
tests against those survivors took it to 100%, and those tests check behaviour
somebody would actually miss.

### Responding to a survivor

In order of preference:

1. **Write the assertion that kills it**, if the mutated behaviour would be
   wrong. This is the usual case and the reason to run it.
2. **Delete the code**, if nothing can tell the difference. A mutant that
   survives because the branch has no observable effect is dead code with a
   test-shaped hole around it.
3. **Leave it, with a comment saying why.** Legitimate for equivalent
   mutants — a change that cannot alter behaviour, such as reordering an
   independent guard. Rare. If you are reaching for this often, the tests are
   asserting the implementation rather than the requirement.

Never chase the score with tests that assert the code back to itself. A test
written by reading the implementation kills the mutant and verifies nothing; two
bugs in this repository were enshrined exactly that way.

### Where it applies

Configured for `packages/schema`, `packages/truelayer`, `services/transform`,
`services/api` and `agents/categoriser` — the packages that are mostly decisions
rather than plumbing. CLIs and batch entry points are excluded from mutation
(`*-cli.ts`, `run.ts`): they are sequences of I/O, where a survivor tells you
little and a kill costs a lot of mocking.

Packages dominated by AWS calls — `ledger`, `ingest` — are not configured yet.
Their risk is better addressed by the integration tests, and by extracting
decisions into functions that can be tested at all, as `selectConnections` was.
