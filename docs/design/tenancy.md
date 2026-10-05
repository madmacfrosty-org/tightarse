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

Four things. Two exist unchanged, one existing row gains a field, one is new.

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

### Role — new, on the member row

```
MEMBER#<email> → { email, tenantId, role, addedAt }
```

`admin` or `member`. One household per person, so a role needs no scoping
beyond the row it sits on.

**What an admin may do that a member may not.** Only worth naming if something
enforces it, so the list is the design:

| Capability | admin | member |
|---|---|---|
| Read the ledger, any page | yes | yes |
| Connect a bank | yes | no |
| Remove or renew a connection | yes | no |
| Add or remove a member | yes | no |
| Change household settings | yes | no |
| Categorise, adopt rules | yes | yes |

The line is roughly: anything that spends a consent, ends one, or changes who
can see the household. Those are the acts with consequences outside the
screen — a connection removed stops a feed, a renewal spends a token, a member
added gives somebody a household's finances.

Categorisation stays open to everyone deliberately. It is corrigible: a wrong
rule is re-adopted, and a household where only one person may tidy the books
is a household where the books do not get tidied.

**Enforced in the API, not in the dashboard.** A hidden tab is a courtesy; the
route is still there and still reachable with a token. Each capability checks
the role the way it already checks the tenant — from the verified claim, never
from the request.

**The claim carries it.** The pre-token trigger already turns a member row into
`custom:tenant`; it adds `custom:role` from the same row and the same read.

The cost is staleness: a demotion does not take effect until the token is next
minted. That is the same property `custom:tenant` already has and the same one
that makes both cheap — no lookup per request. For a household it is the right
trade, and the note belongs here so that the day it is not, the reason to
change is on the record. A capability that must revoke instantly reads the
member row directly instead.

### Which tabs a person sees — settings, not a role

"Not everybody is interested in the operations tab" is a preference, and
modelling it as a permission is the mistake that makes permission systems
decorative. A member who finds Operations irrelevant and a member who must not
reach it are different people with different needs, and one mechanism serving
both serves neither: the preference gets enforced where it should not be, or
the permission gets hidden where hiding is not enough.

So: person-level settings decide which pages are shown, for anybody, at their
own choice and reversible by them. The role decides which capabilities answer.
A member can hide Operations because it is noise; a member cannot reach the
renewal capability because the API refuses.

They do overlap in one place, and sensibly: a page whose every action the role
forbids is not worth offering, so the default view for a member can omit it.
That is a default, not a lock.

### TenantSettings — exists, unreachable

Already at `T#<tenantId>/SETTINGS`, already read with fallbacks by the consent
health calculation. `putSettings` has no caller outside tests, which is #151.

Person-level settings are the other half of #151 and belong at
`MEMBER#<email>/SETTINGS` — keyed to the person, because they follow the person
rather than the household. Which pages somebody wants to see lives here.

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

Roles are a separate sequence and can run independently:

1. Add `role` to the member row, defaulted to `admin` for everyone who exists
   — the household today has no members who should lose anything, and a
   migration that silently demotes people is a support call.
2. Mint `custom:role` in the pre-token trigger.
3. Enforce it, capability by capability, starting with the ones that spend or
   end a consent.
4. Offer `member` when adding somebody, once there is something to protect.

Step 3 before step 4 on purpose: a role nothing enforces is worse than no role,
because it reads like a guarantee.

Steps 2 and 3 are separable on purpose: the dispatcher can be exercised against
dev's household before anything in prod is repointed.

## Decisions needed

These change the shape of the work and are not mine to assume.

**Is the capability split above right?** The table is a proposal, not a
settled thing. The question for each row is whether a household would ever
want a member who cannot do it — and if the answer is no for a row, that row
should not be in the table at all.

**Should onboarding be a capability?** #94 makes the point that `seed.ts` exists
only to bring up a new household. A `Tenant` row is the thing it would create
first, and the two issues meet there.
