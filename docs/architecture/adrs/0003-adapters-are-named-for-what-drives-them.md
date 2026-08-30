# 3. Services and agents become adapters, named for what drives them

Status: proposed
Date: 2026-08-30

## Context

`services/` holds four workspaces — `api`, `auth`, `ingest`, `transform` — and
`agents/` holds one, `categoriser`. Each is a mix of three things: a handler,
logic that belongs in the domain, and command line tools.

In ports and adapters terms none of them is a service. They are inbound adapters:
something outside drives them, they build dependencies, and they call a use case.
The outbound adapters already exist as `truelayer`, `dynamodb` and `aws`.

`agents/` is emptier still. `categoriser` contains no agent — the model-driven
path was deleted when categorisation became a deterministic application of rules.
Two thirds of its 928 lines are command line tools; the rest is one scheduled
handler and two implementations of the domain's `RuleProposer`.

## Decision

`services/` and `agents/` become inbound adapters under `packages/adapters/`,
named for **what drives them** rather than for the runtime that hosts them:

| driven by | adapter | from |
| --- | --- | --- |
| an HTTP request | `http` | `services/api` |
| a Cognito trigger | `cognito` | `services/auth` |
| an object landing | `events` | `services/transform` |
| a state machine | `steps` | `services/ingest` |
| a schedule | `schedule` | categorise, reconcile, daily sync |
| a person | `cli` | every command, from four workspaces |

Not `lambda`. A directory named for its runtime tells you where the code runs and
nothing about what it is for, and the same handler moved to a container would
need renaming without changing a line.

**Command line tools are adapters.** A CLI parses input, builds dependencies,
calls a use case and formats output — the same shape as an HTTP handler. It sits
in `adapters/cli` as a sibling of the others rather than at the top level. Two
things about it are different and neither is architectural: it is not deployed,
and its output is read by a person, which is why dry-run is the default and why
a household's rules are not printed to a terminal that may be shared.

**The dashboard is not an adapter.** `web` depends only on `api-contract` and the
test config, touches no domain type, and reaches the system over HTTP like any
other client. It is a separate application on the far side of the network
boundary; the thing adapting HTTP to the domain is the `http` adapter. It moves
to `packages/web` and stays outside `adapters/`.

**Domain logic moves to the domain.** From the categoriser that is
`conflict-resolver.ts` and `authored-proposer.ts`, both implementing
`RuleProposer` over `Evidence` and `RuleSet` — domain types already. The
equivalent inside the four services has not been itemised yet, and must be before
it can move.

## Consequences

`services/api` currently depends on `services/transform`, because a test imports
`mapTransaction`. That edge disappears: mapping a provider payload into a domain
object is the TrueLayer adapter's work, so `map.ts` goes there and no adapter
imports another.

`ingest/src/connections.ts` reads and writes connection secrets. It is an
outbound adapter that has been living inside a service, and it moves to the
outbound side — whether as its own adapter or folded into `aws` is not settled
here.

Five inbound adapter packages may be too many for what each contains. The
alternative is one `inbound` package with a directory per driver, which trades a
weaker boundary for less ceremony. Named separately for now because the boundary
is the point of the exercise, and merging later is easier than splitting.
