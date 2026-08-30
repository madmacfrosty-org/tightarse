# 1. `packages/` is the single root for code

Status: proposed
Date: 2026-08-30

## Context

Code lives under four top-level directories — `packages/`, `services/`, `agents/`
and `web` — and the split no longer describes anything.

`packages/` was for shared libraries, `services/` for deployables, `agents/` for
model-driven work. That distinction stopped holding:

- `services/transform` exports `mapTransaction` and is imported as a library by
  `services/api`.
- `agents/categoriser` contains no agent. The model-driven path was deleted when
  categorisation became a deterministic application of rules; what remains is
  command line entry points and a scheduled handler.

Every one of them is an npm workspace. The top-level directory therefore costs a
decision on creation and returns no information on reading.

## Decision

`packages/` is the single root for code. `services/` and `agents/` disappear, and
`web` moves under it.

Two directories stay at the top level:

- **`infra/`** — deploys the others rather than being one of them.
- **`spike/`** — throwaway. Keeping it visibly outside stops it being mistaken
  for something maintained.

`docs/` and `scripts/` are not code and are unaffected.

## Consequences

Every workspace path changes, so every `package.json`, `tsconfig` reference and
import path is touched once.

The question "is this a service or a package?" stops being asked, because it
stops having an answer. What a thing is becomes visible from its name and its
dependencies rather than from which drawer it was filed in.

This ADR settles only the root. What lives inside `packages/`, and how ports and
adapters are expressed there, is decided separately.
