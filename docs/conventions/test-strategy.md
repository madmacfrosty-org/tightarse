# Test strategy: a narrowing funnel

This is about **where a test belongs**. For how to write one, see
[testing.md](testing.md).

Tests form a funnel, not a pyramid. A pyramid only describes proportions; a
funnel describes flow. Everything enters at the top, and only what genuinely
cannot be caught there passes down to the next stage. Each stage is narrower,
coarser and more expensive than the one above it.

```
  wide, cheap, fast          1  unit
        │                    2  snapshot
        │                    3  integration — DynamoDB Local
        ▼                    4  integration — real AWS
  narrow, coarse, costly     5  synthetic canaries against the deployed system
```

## The two rules

**Push every test as far up the funnel as it will go.** A test belongs at the
highest stage that can still fail for the real reason. Anything lower is paying
more for the same answer.

**Every stage must be able to fail for something the stage above cannot.** A
lower-stage test that only repeats an upper-stage one is pure cost — slower,
flakier, harder to diagnose, and it will eventually be deleted in frustration
along with whatever it *was* protecting.

There is a corollary worth taking seriously: **when a test fails low in the
funnel, ask what should have caught it higher up.** A canary catching a sign
inversion is a canary doing its job and a unit test that was never written.

## The stages

### 1. Unit — decisions and transformations

Wide, granular, and the only stage fast enough to run on every save. This is
where the ledger's real thinking lives: sign conventions, dedup keys, transfer
matching, money conversion, categorisation rules.

Its purpose is not only defect detection. **Good unit tests are what make
refactoring cheap**, which is why they must assert behaviour rather than
implementation — a test coupled to how the code is written charges you for every
improvement to it.

Quality here is checked by mutation testing, not by coverage. Coverage says the
line ran; the mutant says whether anything cared.

### 2. Snapshot — generated artefacts

Cheap and broad, and worth being precise about what it is for.

**A snapshot is a change detector, not a correctness check.** It cannot tell you
that an IAM policy is right; it tells you that it is different from last week.
That makes it valuable for large generated artefacts nobody reads in full — the
synthesised CloudFormation template, the state machine definition, an API
response shape — where an unintended change is the likely failure.

It is the wrong tool for logic. A snapshot of a calculation records whatever the
code produced, including the bug, which is the same trap as writing a test by
reading the implementation.

### 3. Integration against DynamoDB Local

Real client, real API surface, no network and no account. Catches what unit
tests cannot: key construction, condition expressions, query and pagination
semantics, marshalling.

This is now the *inner loop* stage rather than the authoritative one, because it
does not catch what the emulator gets wrong, and it does get things wrong.
Measured here: the same suite took different paths against Local and against
real DynamoDB, 79.03% branch coverage versus 81.2%. Conditional writes and
transactions are where the divergence concentrates, and `putEnrichment` — a
`TransactWriteItems` with a `ConditionCheck` — sits exactly there.

### 4. Integration against real AWS

Costs credentials, network and pennies. Earns it by catching what an emulator
cannot: transaction and conditional-write semantics, consistency, error shapes,
IAM, encryption. CI runs the ledger suite here, on a table created and destroyed
per run, which is what makes it authoritative rather than occasional.

Runs in an isolated region and an ephemeral table, never against the household
ledger. That isolation is enforced twice over, because either half alone leaves
a way through. The `tightarse-dev-github-citest` role carries an
`aws:RequestedRegion` condition pinning it to `eu-west-2` and resource ARNs
pinning it to `tightarse-citest-*`, so the credential cannot reach real data;
and `resolveTestTarget` refuses the same combinations in code, for a laptop
whose profile has no such restriction. Neither is a matter of pointing the right
environment variable at the right table.

That role is deliberately not the deploy role. The deploy role's one power is
assuming the CDK bootstrap roles, which carry admin, and the test job runs on
every pull request — merging them would hand a deployment path to any branch.

### 4b. Integration against the provider's sandbox

The same stage, aimed at the other external dependency. `map.ts` and
`transform.ts` are otherwise tested against `generateRawWorld` — fixtures
written to match what we believe TrueLayer sends, which cannot tell us the
belief is still true. A field renamed upstream passes every unit test in the
package, because the fixtures were written from the old name.

Runs against `api.truelayer-sandbox.com` and a mock bank, never against live.
That isolation is structural rather than configured: `resolveSandboxTarget`
returns `SANDBOX` always and offers no way to ask for `LIVE`, so the hazard is
unreachable from the type rather than avoided by care.

The hazard is worth stating, because it is not the usual one. Nothing here can
corrupt data. But `refresh` spends a refresh token and may be handed a new one,
invalidating the old — and prod holds the household's connections. A suite that
reached live TrueLayer with prod's stored token would leave prod holding a spent
token, and the connection dies days later with no remedy but the household
re-authorising at the bank. Data calls would also spend the unattended
allowance, which is four per account, endpoint and consent per 24 hours.

Two tiers, because they cost differently. Most of it needs only the application
credential: the error classifications, and `isConsentExpired` in particular,
which is the one that decides whether a sync retries or asks a human. The
refresh path additionally needs a consent, and minting one costs a single
interactive authorisation at `uk-cs-mock` — after which it is headless and
repeatable.

```sh
# The tier that needs no consent
TL_SANDBOX_CLIENT_ID=… TL_SANDBOX_CLIENT_SECRET=… npm test -w @tightarse/truelayer
# Adding a consent unlocks the refresh and data-shape tests
TL_SANDBOX_REFRESH_TOKEN=… npm test -w @tightarse/truelayer
```

Skipped when unset, which is the failure mode to watch: the DynamoDB suites
once skipped silently on every push for weeks, and a green tick meant nothing.
The answer there was setting the variable statically in the workflow so they
cannot skip in CI, and it is the answer here too once a sandbox credential
exists.

### 5. Synthetic canaries against the deployed system

The narrowest and most expensive stage, and the only one that tests the thing
you actually run. Sign-in through the Cognito trigger, the API refusing an
unauthenticated request, a sync execution succeeding, a consent still valid.

This stage exists because of a specific failure mode: **deployed successfully,
silently broken.** A wrong IAM condition is valid CloudFormation, deploys
cleanly, and fails only when something calls it. Merges to `main` now deploy
themselves, so nothing between a green suite and a broken system checks that it
still works.

## Where this repository actually sits

Honest as of the funnel being written down:

| Stage | State |
|---|---|
| 1 unit | ~130 tests, 48.8% lines where tests exist; mutation testing on five packages |
| 2 snapshot | none, and dropped on purpose — the infra assertion tests cover what has actually broken |
| 3 DynamoDB Local | the inner loop; the same 13 ledger tests, on demand |
| 4 real AWS | 13 ledger tests per CI run, on an ephemeral eu-west-2 table |
| 4b provider sandbox | 7 tests, skipped until a sandbox credential exists — see #178 |
| 5 canaries | 3 Playwright tests against deployed dev, run by hand — see [e2e.md](e2e.md) |

The gap that mattered most was 5, because every incident this project has had was
infrastructure or wiring, and stages 1 to 3 cannot see any of it.

It is no longer empty, and it earned its place on the first run. Before a single
assertion passed it had found: a 500 that logged nothing, so no deployed failure
could be attributed (#170); dev's category rows still carrying `kind` rather than
`nature`, which had been returning 500 on every dashboard load for weeks with
nobody watching; and an account Lambda concurrency limit of 5 against a dashboard
that makes exactly five calls per load.

None of those was reachable from stages 1 to 4. Two of them were invisible
because the thing that would have reported them was the thing that was broken.

Still run by hand rather than in CI. It needs a deployed environment and an
identity, and putting it on every push is a separate decision from having it.
