# 2. `fixtures` dissolves into domain and the TrueLayer adapter

Status: proposed
Date: 2026-08-30

## Context

`packages/fixtures` generates synthetic test data. The repository is public, so
it exists to make the right thing the easy thing: generating a plausible
household should be less effort than pasting a real one.

It has drifted into holding three unrelated kinds of thing.

**Domain vocabulary.** `vocabulary.ts` re-exports `MERCHANTS` from the domain,
with a comment recording why: a second list here is how the two stopped agreeing,
and seeded data arrived entirely uncategorised. The domain list drives both the
seeded rules and the generated descriptions.

**The provider's wire shapes.** `index.ts` declares `RawTransaction` and
`RawAccount`, and its own header states the point: these imitate "the provider's
raw payloads, quirks included — not our clean domain model. That distinction is
the whole point." A credit card's `DEBIT` is emitted positive on purpose,
because that is what TrueLayer sends, and fixtures that tidied it up would have
certified a bug that cost five years of totals being out by £40k either way.

**Generation machinery.** `gen.ts` — a seeded PRNG and combinators (`pick`,
`weighted`, `listOf`). Nothing about this repository is visible in it.

The drift the vocabulary comment warns about has already recurred: `index.ts`
declares a second `MERCHANTS` list, separate from the domain's.

## Decision

`fixtures` is dissolved. Its contents go to the three places they describe.

**To the domain**: generators that produce domain objects, the vocabulary they
draw on, and the machinery they use. A generator that produces a valid
transaction is encoding domain invariants, and it is testable by asserting its
output against the domain's own schema — so it carries its weight in the
coverage and mutation ratchets rather than inflating them.

Payee names come with it. They decide nothing in production, but they are what a
domain-resident generator draws on, and splitting a generator from its vocabulary
is what produced two merchant lists. The constraint that today reads as a comment
— living private individuals must never appear, famous names are used because
they are public and unmistakably not the household's payees — becomes a rule in
the domain, and a rule can have a test.

**To the TrueLayer adapter**: `RawTransaction`, `RawAccount`,
`generateHousehold`, `generatePending` and the sign quirk. These are the
provider's shapes. The domain should not know they exist.

`services/transform/src/map.ts` follows the same reasoning: translating provider
payloads into domain objects is the adapter's work, and it is the only reason
`services/api` currently depends on `@tightarse/transform`.

**Nowhere**: the second `MERCHANTS` list and `DIRECT_DEBITS` in `index.ts` are
deleted in favour of the domain's.

## Consequences

A package disappears and a dependency edge with it.

Test data no longer sits behind a boundary from the model it describes, so the
two cannot disagree — which is the failure this is chosen to prevent, and one
that has already happened twice.

Generators ship inside the package every Lambda bundles from. Keeping them out of
production is then tree-shaking's job rather than the directory structure's,
which is a real cost accepted knowingly.

The rejected alternative was a separate `datasets` package holding merchants and
payee names. It was rejected because the domain must depend on nothing. The
distinction that resolved it is not dataset versus code but whether the data
participates in a decision: merchants drive rules and are model; payee names are
set dressing and travel with the generator that needs them. A dataset that
changed on a different cadence from the code — a merchant list updated weekly —
would stop being a constant and become an outbound port, and the domain would
still depend on nothing.
