# Tenancy: who a piece of work is for

Describes where this is going, not where it is. Nothing below is built.

## The problem

Tenancy is resolved two different ways, and they can disagree.

**On the read path it is data.** A verified email reaches a `MEMBER#<email>`
row, the pre-token trigger turns it into a `custom:tenant` claim, and the API
reads the household from the claim. `api-stack.ts` states the rule: the
household comes from a verified claim "never from the request". Nothing about
a deployment is involved.

**On the background path it is deployment configuration.** `TENANT_ID` is baked
into three Lambdas by CDK from `EnvSettings.tenantId`. The daily sync, the
categorisation schedule and the reconcile job each read it from the
environment. A deployment therefore serves exactly one household, and that
household's identity is infrastructure.

Alongside it sit literal fallbacks — `process.env["TENANT_ID"] ?? "frost"` in
the categorise handler and the reconcile job, `process.env["TENANT"] ?? "frost"`
in three CLIs. A household's name is a default in a public repository.

### It has already cost us twice

**Dev synced a household nobody could see.** `TENANT_ID` was the same literal in
both environments. Dev holds 0 rows for that household and 315 for the one its
members actually belong to, so dev's sync could never have fetched anything a
dev user could open. It went unnoticed for weeks because dev's sync was
disabled, and failed on the first run after it was switched back on.

**Renewal had to invent a link.** The dashboard knows a consent by the
provider's `credentials_id`; the stored connection secrets are keyed by our own
`connectionId`; nothing joined them, because the raw object key carries tenant,
dataset and account and no connection. `credentialsId` was added to the
connection record to bridge it.

Neither is a coincidence. Both are what happens when the same question — *whose
work is this?* — is answered from two places that nothing reconciles.

## What is missing

There is no row that says a household exists.

`TenantId` appears only as a foreign key: on `Member`, on `TenantSettings`, in
every ledger key as `T#<tenantId>`. There is no `Tenant` entity, so nothing can
answer "which households are there?" — and that is precisely why background work
needs an environment variable. It is not that the sync was written lazily; there
is nothing for it to read.

## The model

Three entities. Two exist and need no change; one is new.

### Tenant — new

A household, and the fact that it exists.

```
pk: "TENANTS"            sk: "TENANT#<tenantId>"
{ tenantId, displayName, status, createdAt }
```

Keyed in a single registry partition rather than at `T#<tenantId>`, for the
reason `member` is keyed by email: the lookup runs in the direction it is asked.
"Which households are active" is one query returning every row, with no index
and no scan. A household's own data stays under `T#<tenantId>` where it is.

`status` is the field background work reads: `active` is synced and categorised,
`suspended` is not. Suspending a household becomes a row edit rather than a
deploy, and an onboarding half-finished is not a thing the scheduler trips over.

### Member — exists, and stays as it is

`MEMBER#<email>` → tenantId, already keyed for the direction the pre-token
trigger asks in.

**A person belongs to exactly one household. Decided, not inherited.**

The alternative was considered and rejected. Several households per person
makes `custom:tenant` a list rather than a value, which means every read path
has to choose one — from a parameter the API currently refuses to accept,
because "the household comes from a verified claim and never from the request"
is the property that makes the authorisation model simple enough to be
obviously correct. It would also need a switcher in the dashboard, a notion of
a current household held somewhere, and an answer to what a background job
does for a person who has two.

None of that buys a household application anything. Writing it down here is
the point: the next person to wonder should find the decision rather than the
absence of one.

### TenantSettings — exists, unreachable

Already at `T#<tenantId>/SETTINGS`, already read with fallbacks by the consent
health calculation. `putSettings` has no caller outside tests, which is #151.

Person-level settings are the other half of #151 and belong at
`MEMBER#<email>/SETTINGS` — keyed to the person, because they follow the person
rather than the household.

## How background work finds its tenants

Today: one EventBridge rule starts one execution, which reads `TENANT_ID` and
fans out over that household's connections.

Proposed: the rule starts a **dispatcher**, which reads the registry and starts
one execution per active household. The existing machine is unchanged and still
syncs exactly one household per execution.

```
schedule → dispatcher → query "TENANTS" where status = active
                      → for each: start sync execution { tenantId }
                           → existing machine, unchanged
```

A dispatcher rather than a nested map, for two reasons. One household's failure
stays one household's failure, rather than failing a run that covered four. And
the existing machine keeps its shape, so the change is additive and the per-
household behaviour that has been running in prod since August is not rewritten
to get there.

Execution names become `<tenantId>-<date>`, which also gives idempotence per
household per day — Step Functions rejects a duplicate name, so a dispatcher
that fires twice does not sync twice.

`TENANT_ID` then has no readers and goes, along with the `?? "frost"` defaults.
The CLIs take `--tenant` explicitly: a tool that acts on a household should say
which, and a default that is somebody's real household is the wrong failure
mode when the flag is forgotten.

## What this does not change

The claim path. `custom:tenant` stays exactly as it is — it is the half that was
already right, and this makes the background path match it rather than the
reverse.

The ledger key scheme. Everything stays under `T#<tenantId>`; this adds a
registry beside it and removes an environment variable.

Per-household isolation in the connection secrets. They are already keyed
`.../connections/<tenantId>/<connectionId>`.

## Migration

The order matters, because prod syncs a real household daily and must not stop.

1. Write the `Tenant` rows for the households that exist. Two of them, and they
   are derivable from the member rows already present.
2. Add the dispatcher, reading the registry, starting the existing machine. Deploy
   with the schedule still pointed at the old entry point, so nothing changes.
3. Point the schedule at the dispatcher. Now driven by rows.
4. Remove `TENANT_ID`, the `EnvSettings.tenantId` field and the literal
   fallbacks, once nothing reads them.

Steps 2 and 3 are separable on purpose: the dispatcher can be exercised against
dev's household before anything in prod is repointed.

## Decisions needed

These change the shape of the work and are not mine to assume.

**Does a household need an owner or roles?** Membership is currently flat:
anyone in the household sees everything and an administrator adds members out of
band. Roles are only worth modelling if something will enforce them.

**Should onboarding be a capability?** #94 makes the point that `seed.ts` exists
only to bring up a new household. A `Tenant` row is the thing it would create
first, and the two issues meet there.
