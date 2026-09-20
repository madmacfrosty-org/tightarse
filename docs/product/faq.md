# Product FAQ

- [What is it?](#what-is-it)
- [What is it for?](#what-is-it-for)
- [Who uses it?](#who-uses-it)
- [Why not use a budgeting app?](#why-not-use-a-budgeting-app)
- [What does it cost to run?](#what-does-it-cost-to-run)
- [Why is it built the way it is?](#why-is-it-built-the-way-it-is)

---

### What is it?

A private ledger of one household's money. It connects to the household's banks
through UK open banking, keeps every transaction, works out what each one was
for, and shows what the household has and where its money goes.

### What is it for?

There are three core aims.

**Where do we stand.** What we have, right now, across every account and card,
so a decision about spending can be made without guessing.

**Progress towards our goals.** Whether we are getting where we want to get, at
the rate we need.

**Planning our goals.** Deciding what we are aiming at, and whether it is
achievable.

What each of them takes, broken into things a person sits down and finishes, is
in [jobs.md](jobs.md).

### Who uses it?

One household. In practice one or two people, and the same person behaves very
differently depending on why they opened it:

- **Glancing** — seconds, prompted from outside, wanting one answer
- **Reviewing** — sitting down, tens of minutes, wanting to decide something
- **Keeping categories accurate** — occasional, but necessary maintenance to
  ensure efficient glancing and reviewing
- **Keeping the feed alive** — rare, and about trust rather than money

### Why not use a budgeting app?

1. Nothing on the market meets our product aims satisfactorily.
2. No subscription, for a thing whose whole purpose is not paying for things you
   do not need.

### What does it cost to run?

**Bookkeeping.** Categories do not create themselves. Somebody writes rules,
corrects mistakes, and decides what a new category means. Without that the
figures are noise, so the cost is real and unavoidable — the design question is
how little of it is needed, never how pleasant it can be made.

**Attention every ninety days.** Bank consent lapses. Nothing renews it yet, and
when it lapses every figure goes quietly stale while still looking fine.

### Why is it built the way it is?

Three properties, each with a reason, all documented elsewhere:

- **Deterministic and rebuildable.** Raw provider responses are kept, so the
  ledger can be reconstructed from scratch. Nothing that guesses is ever the
  writer of record.
- **Rules, not a model.** Categorisation is rules the household owns. Improving a
  rule improves last year as well as this one.
- **Derived, not stored.** Positions and totals are computed from transactions
  rather than kept, so a correction corrects everything at once.

See [docs/design/books.md](../design/books.md),
[docs/design/categorisation.md](../design/categorisation.md), and
[CONTRIBUTING](../../CONTRIBUTING.md).
