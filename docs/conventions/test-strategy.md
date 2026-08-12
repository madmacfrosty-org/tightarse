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

It does not catch what the emulator gets wrong, and it does get things wrong.
Measured here: the same suite took different paths against Local and against
real DynamoDB, 79.03% branch coverage versus 81.2%. Conditional writes and
transactions are where the divergence concentrates, and `putEnrichment` — a
`TransactWriteItems` with a `ConditionCheck` — sits exactly there.

### 4. Integration against real AWS

Costs credentials, network and pennies. Earns it by catching what an emulator
cannot: transaction and conditional-write semantics, consistency, error shapes,
IAM, encryption.

Runs in an isolated region and an ephemeral table, never against the household
ledger. That isolation should be enforced by the credential — an
`aws:RequestedRegion` condition makes it structurally impossible to reach real
data, rather than a matter of pointing the right environment variable at the
right table.

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
| 2 snapshot | none — no template or state machine snapshots |
| 3 DynamoDB Local | 13 ledger tests, running in CI |
| 4 real AWS | none as a discipline; done ad hoc against the live ledger, which is the wrong thing |
| 5 canaries | none |

The gap that matters most is 5, because every incident this project has had was
infrastructure or wiring, and stages 1 to 3 cannot see any of it.
