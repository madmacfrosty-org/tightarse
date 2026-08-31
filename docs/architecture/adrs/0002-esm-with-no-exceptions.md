# 2. ESM, with no exceptions

Status: accepted
Date: 2026-08-31
Issue: #128

## Context

The repository was split between module systems without anyone choosing: ten of
sixteen workspaces were ESM, and the six that were not included the domain.

The split ran the wrong way round. ESM can import CommonJS; CommonJS cannot
import ESM. So every adapter, being ESM, could import anything — while the
domain, being CommonJS, was the one part of the system that could not.

That was not theoretical. `reconcile-job` is a use case: it reads a port,
reconciles, and reports. It emits telemetry, `metrics` is ESM, and the domain
could not import it — so the use case was placed in the schedule adapter beside
the handler that drives it. A packaging accident decided where a piece of the
model lived, and would have gone on deciding it.

## Decision

Every workspace is ESM. No exceptions.

Two were proposed and neither survived examination. `infra` was to stay
CommonJS because it is a CDK app run through `ts-node` using `__dirname`; but
`ts-node` swaps for `tsx`, which the repository already depends on, and
`__dirname` becomes `dirname(fileURLToPath(import.meta.url))` in nine places.
`vitest-config` was to stay CommonJS because config files `require` it — but the
only CommonJS consumer was the CDK app, so that exception existed solely to
support the first one. Removing one removed both.

Relative imports carry explicit extensions. ESM does no resolution guessing, and
the imports that lacked one only worked because CommonJS filled the gap.

## Consequences

`reconcile-job` returns to the domain, where it belongs.

The rule to apply when placing anything in future is that the domain must be
importable by everything and able to import anything. Where that is not true,
the layout starts being decided by packaging.

It exposed a circular import that CommonJS had been hiding. `api-contract`'s
barrel re-exported `routes`, and `routes` imported the barrel back for the
schemas it needed at module-evaluation time. CommonJS answered with a
half-built module; ESM refuses, and `cdk synth` failed with "Cannot access
'IsoDate' before initialization". The definitions moved to `schemas.ts` and the
barrel became a barrel, so nothing imports back through it.

That is the argument for uniformity rather than a tidy-looking rule: the cycle
had been there all along, and only the stricter system said so.
