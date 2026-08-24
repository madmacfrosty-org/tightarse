# Rule optimisation

[Categorisation](categorisation.md) describes how rules are evaluated and
applied. This describes how rules come to exist in the first place: who proposes
them, what evidence justifies one, and what has to be true before a household
member presses the button.

It exists because the mechanism landed and the way in is missing. `optimise` runs
from one CLI on a laptop holding AWS credentials; nothing schedules it, no Lambda
packages it, and the API is read-only. A household member cannot correct a single
transaction today.

## What the ledger actually looks like

Measured against production, and the numbers drive most of the decisions below.

| | |
|---|---|
| Transactions | 11,850 |
| Distinct descriptions | 3,893 (3.0 transactions each) |
| Descriptions seen exactly once | 79% |
| Uncategorised | 5,261 transactions in 932 leading-token groups |

Two facts matter more than the rest.

**The tail is long and cheap to ignore.** 467 of those groups appear once and
together account for under 5% of the uncategorised money. A rule per merchant has
no leverage here — it would take thousands of rules to finish the job, and the
last thousand would each earn a single transaction. "Other" is the honest answer
for that tail, and the design should stop rather than chase it.

**Rank by value, not by frequency.** The top 25 groups by value cover 81% of the
uncategorised outgoing; the top 25 by *count* cover 71%, and count-ranking needs
250 rules to reach 86%. The two top-50 lists share only 24 entries, so this is a
different rule set rather than a reordering — high-count groups are small
recurring spends, high-value ones are the payments actually worth tracking.

Scale is not a constraint anywhere near these sizes. Evaluating 1,000 rules
across the whole ledger takes 5.2 seconds and scales linearly. The binding limits
are DynamoDB's 400KB item cap at roughly 1,500 rules per set, the rate at which
conflicts grow with the product of rules and merchants, and the point past which
a human stops reading the diff — which arrives first.

## Correcting one transaction is the primary use case

Not the batch optimiser. Someone looks at a transaction, sees the wrong category,
and fixes it — that is the interaction that earns trust, and it is the one that
does not exist.

The correction is a **seed, not a label**. Categorising one transaction one time
is the merchant-rule trap in miniature: no leverage, and nothing caught next
month. So selecting a transaction searches for others that may belong to the same
pattern, and offers a ladder of increasing generality — this exact transaction (a
`dedupKey` matcher at override precedence), this merchant stem, a wider pattern
(a `merchant` matcher at household precedence). The human picks the rung.

This collapses overrides and pattern rules into two ends of one control rather
than two mechanisms, and it makes propose-and-accept a single action: the change
is authored, the evidence is on screen, and asking someone to approve their own
correction is ceremony. Per-rule acceptance only matters for the batch optimiser.

### Reach is not enough; show the disturbance

A household rule outranks built-in and provider rules. Generalising a pattern can
therefore rewrite categorisations that are already correct, which is
[the risk categorisation.md states plainly](categorisation.md#the-risk-worth-stating-plainly)
arriving through a new door. Reach alone hides it.

So every candidate rung is presented as a four-way split of what it matches:

- currently uncategorised — the gain, and the number being shopped for
- already this category — no change
- **already a different category, from a lower-precedence set — would be silently recategorised**
- matched but outranked by an existing override — will not win, shown so it is not a surprise

The third is why this is a preview and not a reach count. It is the check that
turns re-application from something that happens to you into something you agreed
to.

## Two axes, and only one is expressible today

Description patterns are one axis. Recurring amounts are another, and they are
close to independent: 87 amount-and-cadence groups cover 20% of uncategorised
transactions and 25% of the uncategorised money, and **74 of those 87 span more
than one distinct description**. A direct debit whose reference changes monthly
looks like a fresh description every time while being the most regular thing in
the ledger. No amount of stemming finds it.

That count is a floor. Grouping was on *exact* amounts, so every variable
direct debit — utilities, anything index-linked — failed to group at all, and
cadence detection was a median gap against fixed periods, which misses anything
paid on the last working day of the month or skipping a month.

Cadence can never be a matcher. `matches(rule, candidate)` sees one candidate;
cadence is a property of the corpus. It is a **discovery** signal only, and the
question is what rule it produces:

- Only 18 of the 87 groups share a leading token, so "cadence discovers, text
  expresses" covers a fifth of it.
- A bare amount matcher would catch 596 unrelated transactions elsewhere in the
  ledger — worse than leaving them alone, because it recategorises things that
  are currently right.

Neither works alone, which points at a composite matcher: amount **and** a loose
text or account constraint, each imprecise, precise together. That makes
`Matcher` recursive with an all-of combinator, leaving the existing three kinds
as leaves and `matches`, `foldSet` and `evaluate` unchanged in shape.

**This is not being built yet.** It is recorded because the measurement was done
and the conclusion is stable; the decision waits on whether real proposals need
it.

## Nothing is stored; everything is computed

A projection of descriptions would be 38x smaller than the transactions it
summarises. It is still the wrong trade.

Reading the whole ledger takes 2.7 seconds and costs around $0.0004 a call.
The corpus grows by roughly 2,400 transactions a year, so a decade out the same
read is about 8 seconds. There is no point in the foreseeable future at which
storage pays for itself for one household.

Correctness settles it. A cache's failure mode is silently wrong reach and value
numbers — and those are exactly the numbers a human reads when approving a rule
that will rewrite five years of history. Live computation cannot be stale.

The latency is covered by the interaction rather than by infrastructure. The
search fires when a transaction is *selected*, not when a category is chosen, so
it runs while the human is still deciding. What a pattern catches depends only on
the matcher, so that work does not need the category. Only the four-way split
does — and rather than pay a second full read, the first response carries the
matched transaction ids with their current effective category and precedence, so
every category the human tries re-renders with no round trip. A deliberate
spinner is then acceptable on apply, which is the only step that writes.

## The API is the contract, and a model outside AWS is its first client

Today's CLIs construct a `DynamoStore` and talk to DynamoDB directly. Everything
built so far has therefore validated nothing about the surface the UI needs.

Building the API first and driving it from a model running *outside* the AWS
account fixes that, and defers the Bedrock decision entirely. Three endpoints
carry the experiment:

- `GET /categorisation/gaps` — the value-ranked summary, with recurrence groups
- `POST /categorisation/preview` — a candidate matcher and category in, reach and the four-way split out
- `POST /categorisation/proposals` — submit a rule set version as `proposed`

Listing and deciding on proposals are needed for the UI, not for the experiment.

**The proposal/acceptance split is already the authorisation boundary.** It was
arrived at for domain reasons, and it happens to be exactly right here: a model
outside the account may propose and measure, and only a human in the browser may
accept. `mayApproveAutomatically` must not be reachable by that principal, or the
boundary leaks.

Authentication is **SigV4**, on those routes only, with the Cognito authorizer
left in place for the browser. The offline caller signs with AWS credentials it
already holds, so there is no new secret to store — which matters in a public
repository.

It also keeps real data out of files. The alternative — dumping a corpus summary
to disk for a model to read — puts thousands of real descriptions in a file, and
[that is not allowed to happen](../../CONTRIBUTING.md#this-repository-is-public).
Over the API the data stays in transit.

If the proposals turn out to be good, the same endpoints can later be driven by a
Lambda with Bedrock behind it, and nothing else changes. If they turn out to be
poor, the API is one the UI needs regardless.

### Why a model and not ML

There is not enough data, but volume is not the real objection — **label
provenance** is. The only labelled transactions are the ones a rule already
matched; the unlabelled ones are unlabelled precisely because no rule did. The
training set and the target set are disjoint by construction, so a classifier
trained on the first learns to imitate rules that already run for free and
deterministically, and generalises worst exactly where help is needed. That
objection would stand at 100,000 labelled transactions.

What is missing is not a decision boundary but **world knowledge** — that a given
string is a supermarket, an energy supplier, a streaming service. No amount of one
household's history contains that fact.

So the split is: deterministic code finds the groups and measures them; the model
names them and proposes patterns and categories; deterministic code computes what
the proposal would actually do; a human confirms. The model is the only step that
cannot be checked by rerunning it, so it is the step checked by the other two. All
3,893 descriptions are on the order of 35,000 tokens — a single call, cheap enough
to run whenever.

## What this supersedes

`categorisation.md` excludes an approval queue from the first cut, on the grounds
that "everything defaults to taking the latest until there is a reason not to".
A model proposing rules from outside the account is that reason. Acceptance is now
explicit for derived proposals. Human corrections still take effect immediately —
they are authored, and the evidence was on screen when the human chose.

## Open questions

- Whether the ladder's rungs are generated deterministically or by the model.
  Deterministic is instant, free and testable, and the human is right there to
  judge; a model is better at knowing two spellings are one merchant but costs
  seconds at the moment the interaction should feel immediate.
- Whether the composite matcher is worth the domain change now or later.
- How a model's category preferences are corrected. Whether a garden centre is
  Home or Groceries is a preference, not a fact — an argument for small, frequent
  proposals over 100 rules in one review.
