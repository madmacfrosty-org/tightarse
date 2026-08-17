# Categorisation

How a category comes to be attached to a transaction, and why it is modelled
this way. Written before the code, so the reasoning survives the implementation.

Examples here are deliberately anonymised — merchants are real household data and
[do not go in files](../../CONTRIBUTING.md#this-repository-is-public).

## The problems this solves

Measured against the real ledger while designing this:

- **Coverage.** 44% of transactions carry no category. The daily run adds
  approximately nothing, because it is rules-only, looks back 45 days, and
  considers only transactions with no categorisation at all.
- **Correctness.** A broad pattern for a supermarket chain is evaluated before a
  narrower one for fuel, so filling the car at a supermarket forecourt reads as a
  food shop. 26 transactions are wrong this way.
- **Durability.** Improving a rule cannot fix the past. Nothing records which
  rule produced a category, so "why is this Groceries?" is unanswerable and every
  correction is either a no-op on history or a full reprocess.

The third is the one that makes the first two frustrating rather than merely
incomplete.

## Entities

### Category

An entity. Its **label is not its identity** — today it is, which means renaming
one is a data migration across every stored row, and colour is assigned by rank
rather than owned by the category.

| Field | Notes |
|---|---|
| `id` | Stable. Everything references this. |
| `label`, `colour`, `description` | Presentation. Freely changeable. |
| `kind` | `spending` \| `income` \| `movement`. The only thing code may branch on. |
| `taxonomy` | Ours, or a provider's. |
| `retired` | Stops new rules choosing it. Existing categorisations still resolve. |

**Categories are never deleted.** Merging is expressed as a relationship, not a
deletion, so no taxonomy change ever requires reprocessing.

Relationships are resolved **at read**, with cycle detection and a depth limit:

```
<retired category>      → mergedInto → <replacement>
<provider category>     → mapsTo     → <household category>
```

`kind` earns its place immediately. Today transfer *detection* — which pairs a
debit against a credit by amount, account and time — and the transfer *category*
are entirely unrelated mechanisms. Nothing reconciles them, so a transaction can
be categorised as a transfer and not netted, or netted and categorised as
something else, and neither is noticed. `kind: movement` is where they meet.

Nothing in the codebase currently branches on a category name, checked before
committing to this, so moving from a closed union of labels to runtime entities
costs nothing in code. The union buys authoring-time typo safety, not
correctness; `kind` keeps that safety where it matters.

### RuleSet

An entity. Versioned. Sets are the unit of precedence, trust and custody.

| Field | Notes |
|---|---|
| `id`, `name` | |
| `version` | Bumped when any member changes. Recorded on categorisations. |
| `order` | Explicit precedence. Data, never load order. |
| `authored` | True means never regenerated. See custody below. |

Typical sets, highest precedence first:

```
household   hand-written, authored
assisted    proposed by a model, accepted by a human
built-in    shipped patterns, seeded from code
provider    a provider's own classification
```

`order` must be explicit data, because it decides whether a model-proposed rule
can ever beat one written by hand. That should be impossible by construction
rather than by convention.

### Rule

A **value**, not an entity. Editing a rule does not mutate it; it produces a new
rule set version containing a different value. So there is no per-rule
generation and no `enabled` flag — disabling is a set version without it — and
the old value still exists in the old version, which makes "what did this rule
say last quarter?" a read rather than a reconstruction.

Where identity is needed it is the **content hash**, the same content-addressed
identity a transaction has.

A rule has a **matcher** and a **contribution**.

Matchers are predicates over a transaction, not patterns over a string:

```
{ kind: "merchant",         pattern }
{ kind: "providerCategory", value }
{ kind: "transaction",      dedupKey }
```

Contributions are a small closed algebra:

- **assert** — establishes a category
- **refine** — narrows or redirects one already established
- **tag** — attaches an attribute without touching the category

Three kinds is expressive enough for every case encountered; arbitrary
transforms would produce rule sets nobody can reason about.

The `refine` kind is what makes the supermarket-forecourt case expressible. It
was never two rules disagreeing — it is a merchant and a qualifier:

```
<supermarket>            asserts  Groceries
<forecourt qualifier>    refines  → Fuel
```

The same shape captures one branch of a department store selling only food while
others also sell clothing: a merchant assert, refined by a location qualifier.

Learned evidence — how many sightings support a rule, and with what
confidence — is **not** on the rule. It is mutable state about a rule that
changes without the rule changing, and putting it there would mint a set version
on every sighting. It lives as evidence records keyed by merchant.

### Categorisation

Links a category to a transaction. **Versioned**, which is what provides the
history of a transaction's classification over time.

| Field | Notes |
|---|---|
| `transaction` | `dedupKey` |
| `category` | `categoryId` |
| `ruleSet`, `setVersion` | Always present |
| `rules[]` | The contributing rules. May be empty where the categoriser is opaque. |
| `version`, `status` | `effective` \| `proposed` \| `superseded` |
| `confidence`, timestamps | |

`rules[]` rather than a single rule, for two reasons: a set may compose an answer
from several, and some categorisers cannot expose one at all.

Versioning subsumes what were previously separate reclassification strategies:

- new versions may be appended freely → *take the latest*
- a human-authored version is effective and nothing derived may supersede it →
  *pinned*
- a new version is appended as `proposed` while the previous stays effective →
  *approval required*

"Which version is effective, and what may append" replaces the strategy enum, and
the rule that a pending proposal must not change what is displayed falls out
rather than needing enforcing.

### Transaction — not an entity

Its identity is **content-addressed**: the dedup key hashes account, timestamp,
amount and description together with the provider identifier. Change any of them
and it is a different key, therefore a different row. It cannot be mutated.

Its content is entirely derived from the raw zone — replaying the raw objects
reproduces the ledger exactly, which has been done.

So a transaction is an **immutable stored fact with durable identity**. Two rules
follow, and they are the reason the model looks the way it does:

1. **Nothing authored may live on a transaction row.** A rebuild regenerates it.
2. **The key derivation must never change.** Every reference dangles if it does.

A consequence worth knowing rather than discovering: because the key is
content-addressed, a provider restatement does not update a transaction, it
*orphans* every reference to it. No restatements were found in five years of real
data, which is the reassurance rather than the guarantee.

Pending transactions are excluded. They genuinely do have mutable state and are
replaced wholesale, so they are a different animal.

## Provider classification

Every transaction carries the provider's own value, and 100% coverage is
misleading: the values are payment rails rather than spending categories, and the
two most common — over three quarters of the ledger — say nothing about what the
money was for.

These are modelled as categories in the **provider's taxonomy**, resolved through
`mapsTo` where a mapping is meaningful and contributing nothing where it is not.
Nothing pretends the provider produced a household category; it produced its own,
and the equivalence is an assertion we own and can explain.

The categorisation is **derived on read** from the value already on the immutable
transaction row, so it costs no storage.

Its version is an **observation stamp**, not a version of the provider's logic —
they publish none. Naming it `version` would imply we could detect a change in
their classification; recording it as an observation admits we could not.

This retires the `provisional` flag. Trust is a property of a rule set, so
whether a category came from a low-trust source is derived from which set
produced it, rather than a boolean every client must remember to check.

## Evaluation

**Every set is evaluated. Within a set, matching rules are folded in order.**

```
household   → (no match)
assisted    → Groceries
built-in    → Groceries
provider    → <payment rail>, no mapping, contributes nothing
```

The **effective** categorisation is the highest-precedence set that produced one.
Cardinality stays sane — at most one per set — and "what did each source say"
becomes directly answerable, which is the audit question.

All matches are computed even where only the fold's result is effective. It is
nearly free once memoised on the merchant key, and it surfaces two distinct
signals:

- two `assert`s colliding within one set → a genuine conflict
- `assert` then `refine` → intended composition, silent

This distinction is not available under first-match-wins, which is why the
forecourt defect went unnoticed.

Order within a set is data, so the fold is deterministic.

## Application

One operation — *apply sets to a scope, compare with what is there, append a
version where it differs* — with two triggers:

- a new transaction arrives (scope of one)
- a rule set version changes (scope of all)

**Scope cannot be narrowed by a changed rule's footprint.** Composition breaks
that: a new `refine` changes the outcome for transactions where a *different*
rule did the asserting. Full re-application is the honest default, and it is
cheap — memoised on the merchant key it is on the order of two thousand folds,
not twelve thousand.

Write volume is proportional to **changes**, not to transactions, because an
unchanged result writes nothing.

**Idempotency is load-bearing.** Applying the same set version to the same
transaction must give the same answer, or every run appends versions and the
history fills with churn. This deserves a test that applies a set twice and
asserts the second run writes nothing.

### Custody

Re-application touches **derived** categorisations only. A set marked `authored`
is never regenerated.

This is not a stylistic preference. Derived data overwriting authored data has
already happened here — placeholder account details overwrote real ones fetched
moments earlier, and every current account read "unknown" for a while. The fix
both times was structural separation rather than discipline, and the same applies
here: "improve the rules" must not be an operation capable of destroying the only
data that cannot be rebuilt.

## The model authors rules, not categorisations

A model is used to **propose rules**, never to classify transactions directly.

This removes the one exception that ran through every earlier draft. Model output
is not reproducible, so classifying directly means categorisations that must be
materialised, excluded from re-application, and never regenerated. If the model
only authors rules, every categorisation is rule-derived and therefore
reproducible, re-application is total, and the custody boundary above has nothing
awkward to protect.

It also generalises where classification cannot. Classify-then-promote only ever
learns merchants already seen; a proposed pattern also catches the ones that
arrive next month. That matters because most distinct merchants in the backlog
have been seen exactly once, and many of those are one sighting of a chain.

And the output is reviewable. Thousands of classifications is a pile nobody
audits; a couple of hundred rules is a diff readable in ten minutes. Provenance
becomes a pattern you can look at rather than "a model said so".

### Import is source-agnostic

The durable piece is the **import**, not the source. Rules arriving from an
interactive session, a hosted model, or a person all come through one door and
face the same checks:

- every referenced category exists and is active
- each matcher's **match set is computed against the real corpus** before
  acceptance — how many transactions, how many distinct merchants, with samples
- breadth is gated: narrow patterns land, broad ones need explicit acceptance
- dry-run first

Breadth gating is the containment for the one real risk. A model writing patterns
will overreach, and a broad pattern does the most damage — the same mistake a
human makes when they generalise one branch of a shop to the whole chain. Because
match sets are computed locally, breadth is a reviewable number rather than a
guess, and the rules needing review are exactly the few that matter.

Imported rules land in the **assisted** set, below household. Landing them
alongside hand-written rules would let the first bad proposal silently outrank a
deliberate correction.

Provenance records both hands: proposed by, imported by, imported at.

### Consequence

A hosted model becomes an *optional automation of a workflow that already works
by hand*, rather than a prerequisite. The manual loop is periodic curation rather
than a pipeline — appropriate, since rules are curation work, and the corpus
grows by roughly fifty new merchants a month. What decays without it is coverage
of new merchants, gracefully, rather than anything breaking.

## Overrides

A human correcting a single transaction is a rule with a `transaction` matcher,
in a set marked `authored`.

Unifying the concept buys uniform provenance and makes promotion natural:
generalising an override is moving a rule into a higher set with its matcher
widened. But **custody must be structural, not remembered** — if the `authored`
flag has to be respected by discipline rather than enforced, overrides should
stay a separate thing entirely. They are the only data here that cannot be
rebuilt.

Two reports fall out, and they are the cheapest quality signal available:

- overrides now **redundant**, because the ruleset produces the same answer — so
  manual state shrinks instead of accumulating
- overrides now **contradicting** the ruleset — direct evidence of a rule defect,
  naming the rule

## Storage

Single table, existing conventions.

```
Category         pk T#<tenant>        sk CATEGORY#<id>
RuleSet          pk T#<tenant>        sk RULESET#<id>#<version>
Categorisation   pk T#<tenant>#TX     sk <timestamp>#CAT#<dedup>#<version>
```

`CAT` sorts before `EN`, `OV` and `TX`, so a categorisation arrives in the same
range query the API already makes for transactions. Versions of one
categorisation sort adjacently, so the effective one is the last of its group.

**A constraint to design around rather than discover:** a rule set version as a
single immutable document is elegant, but a large assisted set approaches
DynamoDB's 400KB item limit at a few thousand rules. Large sets need chunking;
small curated ones can stay documents. Decide deliberately.

## Excluded from the first cut

- Relationship-derived attributes — whether a hotel was expensed and later
  reimbursed. These key on a trip, not a merchant, and must never be promotable
  into a rule. Merchant identity is stable; context is not.
- Period close.
- An approval queue. The `proposed` status exists so the shape is right, but
  everything defaults to taking the latest until there is a reason not to.
  Approval queues get abandoned, and an abandoned one leaves transactions in
  limbo.

## Migration

1. Existing categories become entities, seeded from the current list. Labels stay
   identical, so nothing visible changes.
2. Hand-written rules become the `household` set; shipped patterns are seeded as
   `built-in` from code, so they remain reviewed through pull requests while the
   table stays the evaluation surface.
3. Existing categorisations carry no rule provenance. Do not invent it — mark
   them stale and let the first application derive it properly. Where nothing
   matches any more, they surface as needing attention rather than silently
   keeping a category nobody can explain.

## The risk worth stating plainly

Re-application makes it possible for the system to **change history**. That is
the point, and it is also what can erode trust: a figure someone looked at last
month quietly saying something different now.

The version history is the mitigation, and it is not optional. The first real
re-application should be run as a dry run against live data with the diff read by
a human before anything is written.
