# Contributing

Mostly notes to my future self.

## This repository is public

That is deliberate — it buys free secret scanning with push protection, free
Actions minutes and Dependabot. It also means three things must never land:

**1. Credentials.** TrueLayer `client_id`/`client_secret`, refresh tokens, AWS
keys, account ids. Public repos are scraped by bots within seconds of a push.
Real values live in Secrets Manager or SSM Parameter Store and are referenced by
name. Run `npm run prepare` once per clone so the `gitleaks` pre-commit hook is
active, and `brew install gitleaks` so it actually does something.

**2. Real transaction data.** The tempting move when an API response confuses you
is to paste it into a fixture. That is your family's spending, permanently, in
git history. Fixtures are synthetic — generate them, do not capture them. If a
real capture is ever genuinely needed for debugging, it goes in a separate
private repo, never here.

`@tightarse/fixtures` is the only acceptable source of test data:

```ts
import { generateHousehold, generatePending } from "@tightarse/fixtures";

const { currentAccountTransactions, cardTransactions, expectedTransferPairs } =
  generateHousehold({ seed: 99, from: "2025-01-01", to: "2025-07-01" });
```

It is seeded, so a failure is reproducible from the seed alone, and it emits
**raw provider payloads including the provider's quirks** — not our tidy domain
model. That is deliberate and it is the whole value of the thing.

TrueLayer reports each resource from that resource's own point of view, so a
credit card's `DEBIT` is **positive** while a current account's is negative. We
stored that verbatim for months: every card purchase counted as income, every
card payment as spending, and no card bill ever netted out, because transfer
detection pairs a debit with a credit and both legs were negative. Five real
years of totals were wrong by about £40k in each direction.

Fixtures that looked sensible would have ratified that bug instead of catching
it. So `cardTransactions` emits the inversion on purpose, and there are tests
asserting it still does. If you find yourself "fixing" the generator to make the
signs agree, you are removing the reason it exists.

**3. Commercial and regulatory material.** TrueLayer's agent terms, quoted
pricing, ICO registration details. Not secret exactly, but no upside to
publishing. Keep it local or private.

## Household access

Everyone in a household sees every transaction in it. There is no per-member
scoping of data and none is planned — the product is one aggregated ledger, and
two people's accounts in one view is the point of it.

Access is one row per person, and there is a command:

```
export LEDGER_TABLE=<the ledger table>
npm run access -w @tightarse/dynamodb -- list
npm run access -w @tightarse/dynamodb -- grant someone@example.com frost
npm run access -w @tightarse/dynamodb -- revoke someone@example.com
```

Grant **before** their first sign-in. The pre-token trigger reads the member row
to set `custom:tenant` and refuses when there is none — correctly, since a
default would hand an unknown identity somebody's ledger. The symptom is a
successful Google sign-in followed by "no household assigned", which looks like
a broken app rather than a missing row.

Revoking takes effect when existing tokens expire, not immediately.

Presentation preferences, if they ever exist, belong on the member and not in
`TenantSettings` — that holds household-wide decisions like the enrichment mode,
where one person's choice must apply to the shared ledger.

## Testing

Conventions, and the failure behind each one, live in
[docs/conventions/testing.md](docs/conventions/testing.md). Read it before
writing a test here — several of the rules are counterintuitive, and one of them
is that test files are not typechecked.

## Money

Integer minor units (pence). Never floats. `Amount` in `@tightarse/schema`
enforces this.

## Schemas

If a shape is not in `@tightarse/schema` it does not belong in the table. That
package is the single source of truth for CDK, the handlers, the agents and the
web app — the whole point of going all-TypeScript was to have exactly one
definition rather than a hand-maintained pair that drifts.

## The ledger is deterministic

`services/ingest` is the only writer of `Transaction` items. Agents write
`TransactionEnrichment` items and nothing else. This means categorisation can be
re-run, corrected or thrown away without ever putting source financial data at
risk.
