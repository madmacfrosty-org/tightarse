# Tightarse

Personal and family finance aggregation over UK open banking. Pulls transactions
from connected bank accounts via [TrueLayer](https://truelayer.com), stores them
in DynamoDB, and puts a dashboard and some agents over the top.

Built for me and my family first. Possibly a business later, which is why it is
multi-tenant from the first commit.

> **This repository is public.** Never commit real transaction data, TrueLayer
> credentials, refresh tokens or AWS keys. Test fixtures must be synthetic.
> A `gitleaks` pre-commit hook is provided — see [Setup](#setup).

## Architecture

```
EventBridge (daily) ──▶ fetch Lambda ──▶ S3 raw landing zone
                            ▲                    │ s3:ObjectCreated
                    Secrets Manager              ▼
                    (refresh tokens)      transform Lambda
                                                 │
                                                 ▼
                                            DynamoDB ledger
                                                 │
  CloudFront + S3 ──▶ API Gateway ──▶ api Lambda ┘
   (web dashboard)         ▲
          ▲                │
       Cognito       AgentCore Runtime
                     (Strands agents)
```

Fetch and transform are deliberately separate stages. Deep transaction history
is available only once per bank consent, so a bug in the transform must not be
able to corrupt the only copy — raw responses land in S3 first and the
transform can be re-run over them at will, without spending any of the four
permitted unattended calls per day.

Everything is TypeScript. CDK deploys it all to a single AWS account.

## Design decisions

Recorded properly in the issue tracker under the `thinking` label. The short
version:

- **TrueLayer over GoCardless Bank Account Data.** GoCardless has the friendlier
  free tier, but TrueLayer has a credible commercial path via the FCA agent
  model — you operate under their authorisation rather than obtaining your own.
  Switching regulated providers later is expensive, so this is chosen up front.
  The provider client lives behind an interface in `packages/truelayer` anyway.

- **The ledger is deterministic and agent-free.** Ingest writes transactions;
  agents only ever read them and write derived items (`TransactionEnrichment`).
  A non-deterministic process must never be the writer of record for financial
  data, and this way categorisation can be re-run without touching source truth.

- **Multi-tenant from commit one.** `TENANT#<id>` is in every partition key.
  Family are the first tenants. Retrofitting this is a table migration.

- **Money is integer minor units.** Never floats.

- **Consent expiry is a first-class concern.** UK rules require the AISP to
  obtain consent reconfirmation every 90 days or data access stops. There is a
  scheduled job to nudge before that happens. Unattended access is also capped
  at four calls per 24 hours, so ingest runs daily, not hourly.

- **`eu-west-1` (Ireland), not London.** `eu-west-2` does not support AgentCore
  Runtime, only Gateway, Identity and Memory. UK GDPR adequacy covers EU storage.

## Layout

| Path | What |
|---|---|
| `infra/` | CDK app — the only thing that deploys |
| `packages/schema/` | Zod schemas: single source of truth for every item shape |
| `packages/truelayer/` | Provider client, kept behind an interface |
| `packages/ledger/` | DynamoDB access |
| `services/ingest/` | Scheduled sync from TrueLayer |
| `services/api/` | Aggregation API for the dashboard |
| `agents/` | Strands agents, deployed to AgentCore Runtime |
| `web/` | Vite + React dashboard |

## Setup

```sh
npm install
npm run prepare          # points git at .githooks
brew install gitleaks    # required — the hook warns loudly without it
npm run typecheck
```

AWS credentials are needed only for `npm run deploy`:

```sh
brew install awscli      # v2
aws configure sso
```

## Status

Early scaffolding. Nothing deploys yet — see open issues.
