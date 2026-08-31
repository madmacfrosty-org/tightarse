# 1. Lay the packages out as ports and adapters

Status: accepted
Date: 2026-08-30
Issue: #128

## Context

The tree does not describe the architecture. `packages/` was for libraries,
`services/` for deployables, `agents/` for model-driven work, and the code stopped
honouring all three: `services/transform` is imported as a library by
`services/api`, and `agents/categoriser` contains no agent, two thirds of it being
command line tools.

The architecture is hexagonal and mostly already correct. `domain` depends on
nothing but zod, adapters do not import each other, and `ports/{inbound,outbound}`
exists. It simply is not visible from the directory names.

## Decision

`packages/` is the single root for code. `spike/`, `docs/` and `scripts/` stay at
the top level; everything else moves under it, `infra` and `web` included.

Adapters are named for what drives them, not for the runtime that hosts them —
`schedule`, not `lambda`. A runtime is where code happens to run.

| driven by | adapter | from |
| --- | --- | --- |
| an HTTP request | `http` | `services/api` |
| a Cognito trigger | `cognito` | `services/auth` |
| an object landing | `events` | `services/transform` |
| a state machine | `steps` | `services/ingest` |
| a schedule | `schedule` | categorise, reconcile, daily sync |
| a person | `cli` | commands, from four workspaces |

Command line tools are adapters: parse, build dependencies, call a use case,
format output — the same shape as an HTTP handler. The dashboard is not; it
touches no domain type and reaches the system over HTTP like any other client, so
it moves under `packages/` and stays outside `adapters/`.

`fixtures` dissolves. Generators and the vocabulary they draw on go to the domain,
where they are testable against the domain's own schema. The provider's wire
shapes and quirks go to the TrueLayer adapter. Splitting a generator from its
vocabulary is what produced two merchant lists that disagreed, and seeded data
that arrived uncategorised.

## Consequences

Every workspace path changes once, and the `services/api` to `services/transform`
edge disappears with `map.ts` moving to the TrueLayer adapter.

Generators ship inside the package every Lambda bundles from, so keeping them out
of production becomes tree-shaking's job rather than the tree's.

A boundary that is not enforced degrades quietly, which has happened here before.
A lint rule failing an import that points outward or sideways is what makes this
hold — #40.

Not settled: whether `connections.ts` in the steps adapter becomes its own
outbound adapter or folds into `aws`, and whether six inbound adapters is the
right granularity.

Settled in the carrying out, and worth recording because neither was foreseen:

`cli` may import the other inbound adapters, and nothing else may. A command
line is a composition root — it builds dependencies and calls something, exactly
as a Lambda entry does — and the things a person runs by hand are spread across
what the other adapters own. The alternative was to push each command back
beside the adapter it drives, which is the layout this decision exists to leave
behind.

The domain being CommonJS while `metrics` was ESM briefly decided where
`reconcile-job` lived — a packaging accident placing a piece of the model. That
is settled in ADR 2: the domain is ESM and the use case is back where it
belongs.
