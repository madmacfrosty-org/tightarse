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

**3. Commercial and regulatory material.** TrueLayer's agent terms, quoted
pricing, ICO registration details. Not secret exactly, but no upside to
publishing. Keep it local or private.

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
