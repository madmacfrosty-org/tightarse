# What this is, and why

The highest-level description of the product. Plain language, no implementation
— [docs/design](../design) and [docs/architecture](../architecture) hold how it
is built, and this holds what it is for.

Questions marked **[open]** have no settled answer yet. They are the ones worth
arguing about.

---

### What is it?

A private ledger of one household's money. It connects to the household's banks
through UK open banking, keeps every transaction, works out what each one was
for, and shows what the household has and where its money goes.

It is not a service. There is one household, one deployment, and no intention of
a second.

### What is it for?

Three things. Everything else exists to make one of them possible.

**Where do we stand.** What we have, right now, across every account and card,
so a decision about spending can be made without guessing.

**Progress towards our goals.** Whether we are getting where we want to get, at
the rate we need.

**Planning our goals.** Deciding what we are aiming at, and whether it is
achievable.

The first is what makes you open it. The other two are what make it worth
having.

What each of them takes, broken into things a person sits down and finishes, is
in [jobs.md](jobs.md). Which aim a job serves is recorded on the job — this file
does not list them back, because a reverse index is the thing that quietly stops
being true.

### Where does finding waste fit?

It is the lever, not an aim. When progress says you are behind, and the plan
says by how much, spending you did not mean to make is the largest thing within
your control — so most of the work is there.

It is also the part people expect to be the point, so it is worth saying plainly
that it is not. Stopping a forgotten subscription matters because of what it
does to the goal, not because being wrong-footed is annoying.

### Who uses it?

One household. In practice one or two people, and the same person behaves very
differently depending on why they opened it:

- **Glancing** — seconds, prompted from outside, wanting one answer
- **Reviewing** — sitting down, tens of minutes, wanting to decide something
- **Keeping the categories true** — occasional, and the price of the other two
- **Keeping the feed alive** — rare, and about trust rather than money

Designing one surface for all four is how the current single scrolling page
happened.

### Why not use a budgeting app? **[open]**

The honest answer has to come from the person who chose to build it. Candidates,
from what the code implies rather than what anyone has said:

- The data stays in an account the household controls
- Categorisation is rules the household owns and can change retrospectively,
  rather than a vendor's model deciding what counts as groceries
- No subscription, for a thing whose whole purpose is not paying for things you
  do not need
- Five years of history that a provider would not hand over

If none of these is the real reason, the real reason belongs here, because it
decides what must never be compromised.

### What makes this hard?

**Waste is not in the data.** £200 on groceries is not waste; £200 on
subscriptions nobody remembers is. The software can only surface candidates — a
person judges. Every design decision about detection runs into this.

**Money that merely moved looks like money spent.** Paying a card, moving to
savings, repaying a loan: all leave an account, and counting them as spending
overstated the household's outgoings by six figures before it was fixed.

**The history is one-shot.** About an hour after a bank authorisation, only
ninety days remain available, for ever. Getting that wrong costs years that no
amount of retrying recovers.

### What does it cost to run?

**Bookkeeping.** Categories do not create themselves. Somebody writes rules,
corrects mistakes, and decides what a new category means. Without that the
figures are noise, so the cost is real and unavoidable — the design question is
how little of it is needed, never how pleasant it can be made.

**Attention every ninety days.** Bank consent lapses. Nothing renews it yet, and
when it lapses every figure goes quietly stale while still looking fine.

### What does it deliberately not do?

- **It does not move money.** It reads. Nothing here can pay, transfer or cancel
  anything.
- **It does not decide what is waste.** It shows candidates.
- **It does not serve anyone else.** No multi-tenancy beyond what isolation
  requires, no accounts for other households.
- **It does not guess.** A figure it cannot stand behind says so rather than
  estimating.

### What has to be true for any figure to mean anything?

The feed is current, the history is complete over the range being shown, and the
categories are true. If any of those fails the numbers still render, still look
confident, and are wrong — which is the failure mode this project fears most and
has been bitten by more than once.

### What is not built? **[open, in the sense of "how much of this matters"]**

Of the three aims, one is served.

**Where do we stand** — mostly built, and the best part of the application.

**Progress towards goals** — nothing. There are no goals, so there is nothing to
progress against. Net worth is computable but not yet truthful: a mortgage falls
only by what is repaid, because interest is never posted.

**Planning goals** — nothing, and it is a different kind of nothing. Every
number in the system is derived from something that already happened. There is
no concept of a future anywhere in it.

### What would make this not worth doing? **[open]**

The questions worth being able to answer, none of which have answers yet:

- **Does seeing waste change behaviour?** Knowing about a subscription and
  cancelling it are different acts, and only the first is in the software.
- **Is the bookkeeping cost worth the insight?** If keeping categories true takes
  an evening a month to save £30, that is a bad trade honestly stated.
- **What happens if it is abandoned for six months?** Consent lapses, the feed
  stops, and the ledger is a snapshot. Does it degrade into something still
  useful, or into something misleading?
- **Would a spreadsheet updated quarterly do most of this?** If yes, the answer
  is not that it would be less fun.

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
