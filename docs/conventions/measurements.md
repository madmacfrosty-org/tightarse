# Measurements

This repository is public and the ledger behind it is one family's real
finances. Everyone understands that a transaction, a merchant or an account
number must not land in a file. A **count** is none of those things, which is
exactly why it keeps landing.

## Why an aggregate is not anonymous

A row count says how much money moves through a household. A five-year total
says what it earns. A balance quoted to the penny is its money on a given day.
A distribution across merchants says where it shops. None of that is less
identifying for having been summarised first, and published together they are a
financial profile of a named family — the repository has the surname in its
history and the household's tenant id in its code.

It has happened three times. Twice into public GitHub text, once into a source
comment. On one of those occasions the text could be deleted; on another it was
a pull request diff, which GitHub does not allow anyone to delete at all.

## Keep the finding, drop the figure

The instinct that produces these comments is a good one. The prose here explains
a design by citing the measurement that forced it, and that is why it is worth
reading. Nobody should stop measuring, and nobody should stop writing down what
a measurement settled.

Say what it showed, not what it counted.

```
bad   Measured against 1,234 real First Direct transactions, because two
      plausible schemes both merged distinct payments.
good  Measured against the full account and card history, because two plausible
      schemes both merged distinct payments — one collided on reused card ids,
      the other on genuinely repeated purchases.
```

The second is better prose anyway. The number was never the argument; the
collision was.

Where the magnitude genuinely matters, say it in words that do not reconstruct
a total: "the whole ledger", "several thousand rows", "a five-figure sum", "two
accounts and a card".

## What enforces it

- **`tightarse/no-household-figures`** fails the lint on comments carrying money
  quoted to the penny, grouped integers, or abbreviated totals. Runs in
  `npm run lint`, which is the first thing CI does.
- **`.githooks/commit-msg`** applies the same test to commit messages. A commit
  message is more permanent than a comment: rewriting one after a merge means
  rewriting `main`.

Both match a _shape_. Neither can tell a figure read off the ledger from one
invented to explain a test, and invented ones are the clearest way to walk
through arithmetic. So a real exception is silenced where it occurs, with a
reason, which keeps it a decision somebody made rather than a rule nobody runs:

```ts
// eslint-disable-next-line tightarse/no-household-figures -- provider quota, not our data
```

```
Allow-figures: DynamoDB partition write limit, not household data
```

## What enforces nothing

A pull request title or body. An issue. A review comment. A chat window. These
are where it has actually gone wrong every time, because they are the surfaces
no hook sees and the ones written fastest. There is no check to lean on, so the
rule when writing them is the plain one: if a number came from the ledger, it
does not go in.
