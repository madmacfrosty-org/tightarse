# Working on Tightarse

UK open banking aggregation for one household. See [README](README.md) for what
it is and [CONTRIBUTING](CONTRIBUTING.md) for the conventions — that file is
canonical, and this one deliberately does not restate it.

Read before writing code:

- [docs/conventions/test-strategy.md](docs/conventions/test-strategy.md) — where
  a test belongs: the funnel from unit tests down to canaries
- [docs/conventions/testing.md](docs/conventions/testing.md) — how to write one;
  every rule there came from a real failure in this repo
- [docs/design/categorisation.md](docs/design/categorisation.md) — the entity
  model behind categories, rules and categorisations, and why a model proposes
  rules rather than classifying transactions
- [This repository is public](CONTRIBUTING.md#this-repository-is-public)
- [Money](CONTRIBUTING.md#money) and [Schemas](CONTRIBUTING.md#schemas)

## The three that catch people out

**This repo is public and the data is real.** No transaction, description,
merchant, family name, account number or token goes in a file. Test data comes
from `@tightarse/fixtures`. A household's own categorisation rules live in
DynamoDB precisely so they never land here.

**One sign convention: negative left the household, positive arrived.** The
provider does not supply this — it reports cards from the issuer's point of
view, so a card `DEBIT` is positive. `mapTransaction` normalises from
`transaction_type` at the boundary and everything downstream relies on it. Do
not re-derive direction from an amount anywhere else.

**Deep history is one-shot per consent.** Roughly an hour after a bank
authorisation, only 90 days remain available, for ever. Anything touching the
connect flow or `services/ingest/src/steps.ts` can cost five years of history
that no amount of retrying gets back. Raw responses land in S3 first so the
ledger can always be rebuilt; that property is worth protecting.

## Commands

```sh
npm run typecheck          # tsc --build; also produces the dist/ that bundling needs
npm test                   # all workspaces; integration tests need DynamoDB Local
npm run test:coverage      # the same, enforcing each package's coverage ratchet
npm run test:mutation -w <pkg>   # slow; finds tests that run code without checking it
npm run synth              # needs web/dist — run `npm run build -w @tightarse/web` first
```

Coverage thresholds only stop coverage falling. They cannot tell whether a test
checks anything — mutation testing can, and the conventions doc explains how to
read it.

Operational commands — granting household access, managing categorisation
rules, running a categorisation — are in [README](README.md#operating-it).

## Before you say it works

Run it. This project's expensive bugs all passed their tests: a card sign
inverted for five years, an IAM condition valid in CloudFormation and useless at
runtime, a lifecycle rule that synthesised cleanly and failed on deploy. A green
suite means the tests passed, not that the change works — and CI deploys `main`
automatically, so "it synthesised" is not the same as "it is safe to merge".

Report what actually happened, including the parts that failed.
