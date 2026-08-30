# Layout

**This describes a layout we intend, not the one on disk. It is written in the
present tense because that is what a target should read like, but none of it is
true yet. Where the tree contradicts this document, the tree is right about today
and this document is right about where we are going. See #128.**

## The rule

Dependencies point inward. The domain knows nothing outside itself; adapters know
the domain; nothing points outward, and no adapter points at another adapter.

That single rule is what the names exist to make visible. A directory is named
for what it *is* in the hexagon, so an import that breaks the rule is wrong on
the path alone, before anyone reads the code.

## The tree

```
packages/
  domain/
    ledger/         transactions, balances, accounts, reconciliation
    categorisation/ rules, sets, adoption, precedence, evidence, proposers
    household/      members, access, consent
    raw/            the landing zone as the domain sees it
    reporting/      the questions a dashboard asks
    money.ts        amounts, currency, minor units
    ports/
      inbound/      what may be asked of us
      outbound/     what we ask of the outside

  adapters/
    truelayer/      outbound: the bank, its wire shapes, its quirks, mapping
    dynamodb/       outbound: the ledger store
    aws/            outbound: object storage, secrets, notifications
    http/           inbound: driven by an HTTP request
    cognito/        inbound: driven by a Cognito trigger
    events/         inbound: driven by an object landing
    steps/          inbound: driven by a state machine
    schedule/       inbound: driven by a schedule
    cli/            inbound: driven by a person

  api-contract/     request and response shapes, shared with the dashboard
  metrics/          embedded metric format
  vitest-config/    one test configuration, inherited everywhere
  web/              the dashboard
  infra/            CDK: stacks, environments, alarms

spike/              throwaway. Visibly outside so it is not mistaken for upkeep
docs/               including architecture/adrs
scripts/            developer tooling, imported by nothing
```

## domain

The model and the use cases that operate on it. No AWS types, no HTTP, no
`process.env`. A file that cannot be tested by calling a function and asserting on
what it returns is in the wrong place.

Subdirectories are areas of the model, not layers. `ledger` and `categorisation`
are different subjects and neither is above the other. A use case lives with the
area it serves: the split between "model" and "application" is not one a reader
needs at the level of a directory name, and filing by it separates things that
change together.

`ports/` is the only part other code implements. Both sides are interfaces and
neither imports an implementation.

Generators live here too. A generator that produces a valid transaction encodes
domain invariants, and is testable by asserting its output against the domain's
own schema — so it earns its place in the coverage and mutation ratchets rather
than inflating them. What it draws on comes with it, because splitting a
generator from its vocabulary is what produced two merchant lists that disagreed.
See ADR 2.

## adapters

One directory per outside thing. Outbound adapters are named for the thing —
`dynamodb`, not `store` — so a stack trace names something you can find. Inbound
adapters are named for what drives them — `schedule`, not `lambda` — because a
runtime is where code happens to run, not what it is for.

An adapter implements ports and exposes nothing else. It may not import another
adapter: two adapters needing the same helper have found something that belongs
in the domain or in support.

Adapters own their own serialisation, and their provider's mistakes. How a
transaction becomes an item is `dynamodb`'s business. That a credit card's DEBIT
arrives positive is `truelayer`'s, and appears nowhere else.

An inbound adapter holds no rules. It reads configuration, builds dependencies,
and calls a use case. When one starts deciding something, the decision belongs in
the domain and the adapter should be calling it.

## Support

`api-contract`, `metrics` and `vitest-config` are shared and opinion-free. The
test of whether something belongs here: replacing it would change how the code is
written but not what the system decides. If replacing it would change an answer,
it is domain.

## web

Not an adapter. It reaches the system over HTTP like any other client and touches
no domain type. The thing adapting HTTP to the domain is the `http` adapter; this
is on the far side of the network boundary from the hexagon.

## Naming

No directory is named for a pattern. There is no `utils`, `helpers`, `common` or
`shared` — each is where things go when nobody has decided what they are, and the
deciding is the point.

No directory is named for a version. A `v2` in a name is a migration that was
never finished, and the name outlives the migration.

## Enforcement

The rule is checked, not documented. A lint rule fails an import that points
outward or sideways, and the build fails with it. See #40.

This matters more than the layout. The ports have been correct and unenforced
before, and an unenforced boundary degrades quietly: nothing breaks, each
violation looks reasonable on its own, and the shape is gone before anyone
notices it went.

## What this buys

A new reader answers three questions from the tree alone: where the model lives,
what the system talks to, and how it is started. Today those need a dependency
graph and a conversation.
