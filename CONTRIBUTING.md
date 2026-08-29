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
years of totals were wrong by a five-figure sum in each direction.

Fixtures that looked sensible would have ratified that bug instead of catching
it. So `cardTransactions` emits the inversion on purpose, and there are tests
asserting it still does. If you find yourself "fixing" the generator to make the
signs agree, you are removing the reason it exists.

**3. Measurements of the ledger.** A count, a total or a balance is not a
transaction, so the rule above reads as though it permits them. It does not. A
row count says how much money moves through this household; a five-year total
says what it earns; a balance to the penny is its money on a day. Summarising
does not anonymise.

This collides with a habit worth keeping. Comments here explain a design by
citing the measurement that forced it, and that is why they are worth reading.
The convention is **keep the finding, drop the figure** — say what the
measurement showed, not what it counted:

```
bad   Measured against 1,234 real transactions, because two schemes both merged
      distinct payments.
good  Measured against the full account and card history, because two schemes
      both merged distinct payments.
```

`tightarse/no-household-figures` fails the lint on money quoted to the penny and
on grouped integers, and a `commit-msg` hook applies the same test to commit
messages. Neither can tell an invented example from a real reading, so a
genuine exception is silenced individually with a reason. Neither covers a pull
request body, an issue or a chat window — those have caught us out three times
and remain a matter of attention. See
[docs/conventions/measurements.md](docs/conventions/measurements.md).

**4. Commercial and regulatory material.** TrueLayer's agent terms, quoted
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

Integer minor units (pence). Never floats. `Amount` in `@tightarse/domain`
enforces this.

## Schemas

If a shape is not in `@tightarse/domain` it does not belong in the table. That
package is the single source of truth for CDK, the handlers, the agents and the
web app — the whole point of going all-TypeScript was to have exactly one
definition rather than a hand-maintained pair that drifts.

## Layers

Three kinds of workspace, and `npm run lint` fails the build on a crossing.

**The domain model is `domain` and `schema`.** `schema` says what a thing is;
`domain` says what may be done with it, under a `ports` namespace — both what the application requires
outward (`LedgerReads`, `RawObjects`, `Secrets`) and what it offers inward
(`Reporting`). `categorisation` and `truelayer` are domain logic over that
vocabulary, and `metrics` is a pure formatter. No AWS SDK, no `aws-cdk-lib`, no
`@tightarse/aws`, no `@tightarse/dynamodb`, and never an import of a service,
agent or app. Dependencies point inward.

**Tooling — `api-contract` and `fixtures` — is not the domain model, and the
domain may not import it.** `api-contract` is the HTTP adapter's business: the
wire spelling of a result, the URL that serves it, and the OpenAPI generated from
both. It is a promise to clients already installed, and it changes for different
reasons than the application's own vocabulary — a browser reloads, an iOS build
on somebody's phone does not. The two meet in exactly one file,
`services/api/src/wire.ts`, which is annotated on both sides so that a divergence
fails the build rather than reaching a client. `fixtures` is test data; nothing it
produces ships.

**Driven adapters** — `packages/aws`, `packages/dynamodb`. Each implements a port
and holds the SDK that does it. That is the job; the ban above does not apply.

**Driving adapters** — everything in `services/`, `agents/`, `spike/`, plus
`infra` and `web`. Things the outside world starts: a Lambda entry point, a CLI, a
CDK app, a browser bundle. **None may import another.** They are siblings at the
edge; shared code goes in a package. Tests are exempt, and one uses that
deliberately: `services/api`'s sign regression drives real `mapTransaction` output
through the API's own aggregation, because a fake would not have caught the
inverted card sign.

Every import must also appear in its own workspace's `package.json`, and code
under `src/` may only use `dependencies` — not `devDependencies`, which are not
in a Lambda bundle.

None of this is enforced by npm or by TypeScript. Every SDK is hoisted to the root
`node_modules` and every workspace is symlinked into `node_modules/@tightarse/`, so
resolution finds anything from anywhere; project references order the build without
restricting imports. `eslint.config.mjs` is the only gate, and its rules are tested
against violating code in `packages/domain/test/architecture.test.ts` — a `files`
glob matching nothing gives the same clean run as a clean codebase.

## The ledger is deterministic

`services/ingest` is the only writer of `Transaction` items. Agents write
`TransactionEnrichment` items and nothing else. This means categorisation can be
re-run, corrected or thrown away without ever putting source financial data at
risk.
