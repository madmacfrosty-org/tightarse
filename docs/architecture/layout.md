# Layout

**This describes a layout we intend, not the one on disk. None of it is true yet.
Where the tree contradicts this document, the tree is right about today. See
#128.**

The architecture is [hexagonal](https://alistair.cockburn.us/hexagonal-architecture/)
— ports and adapters. Dependencies point inward: adapters know the domain, the
domain knows nothing else, and no adapter imports another.

## The tree

```
packages/
  domain/
    ledger/         transactions, balances, accounts, reconciliation
    categorisation/ rules, sets, adoption, precedence, evidence
    household/      members, access, consent
    raw/            the landing zone as the domain sees it
    reporting/      the questions a dashboard asks
    application/    use cases
    ports/
      inbound/      what may be asked of us
      outbound/     what we ask of the outside

  adapters/
    truelayer/      outbound: the bank, its wire shapes, its quirks
    dynamodb/       outbound: the ledger store
    aws/            outbound: object storage, secrets, notifications
    http/           inbound: driven by an HTTP request
    cognito/        inbound: driven by a Cognito trigger
    events/         inbound: driven by an object landing
    steps/          inbound: driven by a state machine
    schedule/       inbound: driven by a schedule
    cli/            inbound: driven by a person

  api-contract/     shapes shared with the dashboard
  metrics/          embedded metric format
  vitest-config/    one test configuration
  web/              the dashboard
  infra/            CDK

spike/  docs/  scripts/
```

## domain

**Dependencies: none.** Not AWS, not HTTP, not `process.env`. The business logic
lives here — every rule about what a transaction means, what a balance implies,
who may read what.

**Ports** are the only part other code implements. `inbound/` is what may be asked
of the system, `outbound/` what the system needs from the world. Both are
interfaces; neither imports an implementation.

**`application/`** holds the use cases: the operations a port offers, written in
terms of the model and the outbound ports they need.

## adapters

Outbound adapters are named for the thing — `dynamodb`, not `store`. Inbound
adapters are named for what drives them — `schedule`, not `lambda`.

An adapter implements ports and exposes nothing else, and may not import another
adapter. It owns its provider's serialisation and its provider's mistakes: that a
credit card's DEBIT arrives positive is `truelayer`'s business and appears nowhere
else.

An inbound adapter holds no rules. When one starts deciding something, the
decision belongs in the domain.

## Enforcement

A lint rule fails an import that points outward or sideways, and the build fails
with it. The ports have been correct and unenforced here before; an unenforced
boundary degrades quietly. See #40.
