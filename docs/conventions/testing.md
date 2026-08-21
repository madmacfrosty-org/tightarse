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

**Take dependencies as arguments; construct them at the entry point.**
`transformObject(deps, key)` and `completeConnect(deps, args)` can be tested
against fakes. `steps.ts` builds its Secrets Manager and S3 clients at module
scope and sits at 7.5% coverage, which is not a coincidence — it is the file
that spends the unattended-call allowance and decides what gets fetched. A
Lambda entry point is the only place that should call a constructor.

**Name the behaviour and its consequence, not the function.** "refuses a
connectionId that matches nothing" and "nets out every card bill and savings
sweep" tell you what broke; "test selectConnections" does not. A failing test
name is the first thing anybody reads, usually in a hurry.

**Build test data with a builder, not a literal.** `raw()` in `map.test.ts`
takes an override object, so each test states only the field it is about and a
new required field does not touch fifty tests.

**Pin the clock.** A test that derives both "now" and an expiry from
`Date.now()` passes until it doesn't.

**Tests are typechecked, and that was not always true.** Tests live in each
workspace's `test/` directory and are excluded from the build, so for a long time
nothing checked their types. A test once passed rows with no `dedupKey` into the transfer detector;
they collided on `undefined` and the whole ledger was skipped as a single
transfer. The types forbade it and nothing was looking. A `noEmit` project now
covers test files — documenting that hazard was the weaker answer to it.

That project's `include` globs are the thing to check when the layout moves. When
tests were separated from `src`, web's own tsconfig still said `include: ["src"]`
and its tests silently stopped being typechecked: the build stayed green, and
four dynamic `import("./App")` calls left pointing at nothing were only found by
putting `test` back in the include.

**Integration tests share one harness.** `testLedger()` returns a configured
client and a tenant unique to the run; suites do not build their own. Three
hand-rolled copies of that setup used to exist, and the fact that a `ledger`
declared in one `suite()` is invisible in the next produced two failures in a
single afternoon.

They do not clean up after themselves, deliberately. The store is thrown away
after every run — an ephemeral table created and destroyed by the workflow, or a
DynamoDB Local container on a laptop — so sweeping rows protects nothing and
fails confusingly when the scoping is wrong. If you ever point these at a store
that outlives the run, that assumption is what breaks.

**Where a run may point is not a matter of care.** `resolveTestTarget` refuses
any table on real DynamoDB that is not named `tightarse-citest-*`, in
`eu-west-2`, and refuses to default a name at all. The old defaults were
`Ledger` in `eu-west-1` — the live table's name, in the live region — so a
script run with ambient credentials and nothing set found the household ledger,
reported "already exists", and exited successfully. The CI credential carries
the same two restrictions, so a mistake has to defeat both.

CI runs them against real DynamoDB, on a table per run:

```sh
# CI, and anything wanting the semantics that actually ship
LEDGER_TEST_TABLE=tightarse-citest-$USER npm run create-test-table -w @tightarse/dynamodb
LEDGER_TEST_TABLE=tightarse-citest-$USER npm test -w @tightarse/dynamodb

# Locally, against the emulator, which needs no credentials and no region
LEDGER_TEST_TABLE=Ledger LEDGER_TEST_ENDPOINT=http://localhost:8000 npm test
```

The emulator command supplies its own dummy credentials now. It used to rely on
whatever profile the machine happened to have, which CI set in its `env:` block
and a laptop did not, so all twelve failed with `CredentialsProviderError`
against a perfectly healthy emulator.

The table name is set statically in the workflow, so these cannot skip there.
Ten of them skipped silently on every push for weeks, which is a green tick that
means nothing.

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
   mutants — a change that cannot alter behaviour. Rare. If you are reaching for
   this often, the tests are asserting the implementation rather than the
   requirement.

   `transfers.ts` has eight, all guards that are fast paths rather than
   behaviour: removing the zero check leaves zeroes in a bucket that matches
   neither the debit nor the credit filter and is skipped two lines later. The
   comment there says so, so nobody chases them twice.

   `api-contract` has twenty-one, all prose inside `.describe()`. Killing them
   would mean asserting each string back to itself, and deleting them would
   throw away the text that becomes the published OpenAPI documentation. The
   part that is behaviour *is* asserted: every monetary field is checked to say
   it is in minor units, because a client that loses that is wrong by a factor
   of a hundred rather than merely undocumented. The date and month formats are
   asserted too — a generated Swift decoder given `2026-3` fails the whole
   response, not one field. When the OpenAPI document is generated and
   snapshotted, that snapshot covers the remaining descriptions in one place and
   this floor should rise.

Never chase the score with tests that assert the code back to itself. A test
written by reading the implementation kills the mutant and verifies nothing; two
bugs in this repository were enshrined exactly that way.

### Where it applies

Every package, with `break` pinned per package at what it scores today — a
ratchet, like coverage. `incremental: true` caches the report so later runs only
re-test what changed.

`dynamodb` was excluded for a while, and the reason recorded here was that its
code is exercised by integration tests which skip without a table, so all 222
mutants came back NoCoverage and the score read 3.81% — a number measuring the
absence of a database rather than the quality of anything.

That observation was correct and the conclusion was not. Run with DynamoDB Local
up, the same package scores **81.48% in 24 seconds** — higher than several
packages that were never excluded. It needs the emulator, exactly as its
integration tests do:

```sh
LEDGER_TEST_TABLE=Ledger LEDGER_TEST_ENDPOINT=http://localhost:8000 \
  npm run test:mutation -w @tightarse/dynamodb
```

Without those variables it will still report a meaningless 3.81%, which is worth
knowing before anyone concludes the tests have rotted.

Starting floors, which say more about coverage than quality while coverage is
still low:

```
metrics    100.0     categoriser  41.0     ingest      32.9
auth        55.5     truelayer    39.6     transform   28.4
fixtures    35.9     api          31.7     schema      25.8
```

A package total is dragged down by files with no tests at all — 207 of the api's
mutants are simply uncovered — so read the killed/survived split for quality and
the total for a ratchet.
