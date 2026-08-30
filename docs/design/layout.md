# Layout

**This describes a layout we intend, not the one on disk. Everything below is
written in the present tense because that is what a target should read like, but
none of it is true yet. Where the tree contradicts this document, the tree is
right about today and this document is right about where we are going.**

## The rule

Dependencies point inward. `core` knows nothing outside itself; `adapters` know
`core`; `entrypoints` know `core` and wire adapters into it. Nothing points
outward, and nothing points sideways.

That single rule is what the top-level names exist to make visible. A directory
is named for what it *is* in the hexagon rather than for what it does, so an
import that breaks the rule is wrong on the path alone, before anyone reads the
code.

```
core/          the model and what it can do. Depends on nothing.
adapters/      how the outside world is reached. Depends on core.
entrypoints/   how the system is started. Depends on core and adapters.
support/       shared, opinion-free helpers. Depends on nothing.
infra/         the deployment. Depends on contracts, not on code.
```

## The tree

```
core/
  ledger/           transactions, balances, accounts, reconciliation
  categorisation/   rules, sets, adoption, precedence, evidence
  household/        members, access, consent
  raw/              the landing zone as the domain sees it
  reporting/        the questions a dashboard asks
  money/            amounts, currency, minor units
  ports/
    inbound/        what the outside may ask of us
    outbound/       what we ask of the outside

adapters/
  dynamodb/         the ledger store
  truelayer/        the bank
  aws/              object storage, secrets, notifications

entrypoints/
  lambda/           one directory per deployed function
  cli/              one file per command a person runs
  web/              the dashboard

support/
  contract/         request and response shapes, shared with the dashboard
  fixtures/         test data, shaped like real data and never real
  metrics/          embedded metric format
  vitest-config/    one test configuration, inherited everywhere

infra/              CDK: stacks, environments, alarms
```

## core

The model, and the use cases that operate on it. No AWS types, no HTTP, no
`aws-sdk`, no `process.env`. If a file in `core` cannot be tested by calling a
function and asserting on what it returns, it is in the wrong place.

Subdirectories are areas of the model, not layers. `ledger` and `categorisation`
are different subjects; neither is above the other. A use case lives with the
area it serves rather than in a separate `application` directory — the split
between "model" and "use case" is a distinction readers do not need at the level
of a directory name, and filing by it separates things that change together.

`ports/` is the only part of `core` that other code is expected to implement.
Inbound ports describe what may be asked of the system; outbound ports describe
what the system needs from the world. Both are interfaces and neither imports an
implementation.

## adapters

One directory per outside thing, named for the thing rather than for its role —
`dynamodb`, not `store`. The name should tell you what you are looking at when a
stack trace mentions it.

An adapter implements outbound ports from `core` and exposes nothing else. It may
not import another adapter: two adapters that need the same helper have found
something that belongs in `core` or `support`.

Adapters own their own serialisation. How a transaction becomes an item, and
which attributes carry which fields, is `dynamodb`'s business and appears nowhere
else.

## entrypoints

Everything that starts a process. A Lambda handler, a command someone types, the
dashboard.

An entry point does three things: read configuration, build the dependencies, and
call a use case. It holds no rules. When an entry point starts making decisions,
the decision belongs in `core` and the entry point should be calling it.

`lambda/` is filed by deployed function rather than by the service that owns the
code, because the deployed thing is the unit that fails, is alarmed on, and is
rolled back. `cli/` is one file per command, so that finding what `access grant`
does is finding the file named for it.

## support

Things every part of the system may use and none of it can be opinionated about.
A metric format, a test configuration, request shapes shared with the dashboard.

The test of whether something belongs here: replacing it would change how the
code is written but not what the system decides. If replacing it would change an
answer, it is domain and belongs in `core`.

`fixtures` lives here rather than in `core` because it exists for tests, and
because the repository is public: fixtures are shaped like real data and are
never real data.

## Naming

Directories are singular where they name a subject (`ledger`, `household`) and
plural where they name a collection of peers (`adapters`, `entrypoints`). A
package name matches its path: `core/ledger` is `@tightarse/core-ledger`.

No directory is named for a pattern. There is no `utils`, no `helpers`, no
`common`, no `shared` — each of those is a place where things go when nobody has
decided what they are, and the deciding is the point.

No directory is named for a version. A `v2` in a name is a migration that was
never finished, and the name outlives the migration.

## Enforcement

The rule is checked, not documented. A lint rule fails an import that points
outward or sideways, and the build fails with it.

This matters more than the layout itself. The ports have been correct and
unenforced before, and an unenforced boundary degrades quietly: nothing breaks,
each individual violation looks reasonable, and the shape is gone before anyone
notices it went.

## What this buys

A new reader can answer three questions from the tree alone: where does the model
live, what does this system talk to, and how is it started. Today those questions
need a dependency graph and a conversation.
