# Jobs

Every job here serves one of the three aims, defined in
[the FAQ](faq.md#what-is-it-for):

- **where do we stand**
- **progress towards goals**
- **planning goals**

A job that serves none of them does not belong here, however good an idea it is.
The aims are named here and defined there — one definition, one place.

## What counts as a job

One sitting, and you walk away having got what you came for. Cockburn's test:
*can the primary actor go away happy having done this?*

Too big is an aim. "Progress towards goals" is not something anyone sits down
and finishes.

Too small is a step. "Preview what a rule would do" is not why anyone opened
the application; they are halfway through clearing a backlog. Steps are not
written down here — they live in the code and the tests, where they cannot
drift from what is true.

## Roles and modes

The **role** says what someone is doing. The **mode** says what good looks like.
They vary independently, and the householder works in two modes.

| Role | Doing what |
| --- | --- |
| **householder** | Asking a money question |
| **bookkeeper** | Making the categories true, so the figures mean something |
| **operator** | Keeping the feed alive and the ledger honest |

| Mode | Triggered by | Succeeds when |
| --- | --- | --- |
| **glance** | Something outside — about to spend, a passing doubt | One answer, then closed |
| **review** | Yourself — "let us look at the finances" | A decision made |

Good means opposite things in the two modes. A glance that takes thirty seconds
has failed even when the figure is right; a review that answers with one big
number has failed even when it is instant. One surface cannot be optimised for
both, and the page that exists today is what happens when you try.

## Fields

`Today` is written honestly, including "not served". `Done when` is the
observable outcome — a story without one cannot be argued with, and is a wish.

---

# Where do we stand

## J-1 — Know where we stand, right now

Role:      householder
Mode:      glance
Frequency: several times a week · seconds
Story:     When I wonder whether we are all right at the moment, I want one
           figure that accounts for every account and card, so I can stop
           wondering without doing arithmetic.
Today:     Served. Net position leads the page, derived from every book that
           rolls up, and says when it is incomplete rather than quietly
           understating.
Done when: I get the number without scrolling, and I believe it.
Serves:    where do we stand

## J-4 — Understand what a charge actually was

Role:      householder
Mode:      glance
Frequency: weekly · a minute
Story:     When something on the list is unfamiliar, I want enough about it to
           recognise it, so I can tell an ordinary purchase from one worth
           chasing.
Today:     Partly served. Recent transactions shows description, amount, date
           and category, in pages of 100. There is no search from the
           householder's side — searching lives inside the categorisation
           workflow, which is a different job with a different purpose.
Done when: I can find one transaction I half-remember, without entering a
           rule-writing screen.
Serves:    where do we stand

---

# Progress towards goals

Finding and stopping waste is the lever on this aim, and most of the work is
here. Every job below is either noticing something, judging it, or confirming
that stopping it worked.

## J-2 — Notice a cost that has crept up

Role:      householder
Mode:      review
Frequency: monthly · under a minute
Story:     When a month feels more expensive than usual, I want to see what
           **changed**, not what it totals, so I can decide whether something
           needs stopping.
Today:     Not served. "Where it goes" shows one period's split with no
           comparison, so a category that has doubled looks like any other bar.
           Twelve months of `byMonth` exist and are drawn as a flow, but nothing
           states a difference.
Done when: I can name the thing that moved, and by how much, without comparing
           two screens myself.
Serves:    progress towards goals

## J-3 — Find money leaving on repeat

Role:      householder
Mode:      review
Frequency: quarterly · ten minutes
Story:     When I suspect we are paying for things we have forgotten, I want to
           see what recurs, so I can judge each one on whether it is still worth
           it.
Today:     Not served in the dashboard. `detectRecurring` exists in the domain
           and surfaces through the backlog for rule-writing, not as a spending
           view — so recurrence is used to help categorise, never to prompt a
           decision about the money.
Done when: I have a list of what repeats, with how much each costs a year, and
           I can go through it.
Serves:    progress towards goals

## J-5 — Judge whether a cost is worth it

Role:      householder
Mode:      review
Frequency: as prompted by J-2 or J-3 · minutes
Story:     When I am looking at something that might be waste, I want to see
           what it has cost over time and what it sits beside, so I can decide
           rather than guess.
Today:     Not served. A category total for the selected range exists; its
           history, its trend, and what it displaced do not.
Done when: I can answer "is this worth it" from one screen.
Serves:    progress towards goals

## J-6 — Confirm something actually stopped

Role:      householder
Mode:      review
Frequency: monthly · seconds
Story:     When I have cancelled something, I want to be told whether it has
           actually stopped being charged, so a cancellation that silently
           failed does not cost me for another year.
Today:     Not served at all. Nothing records that a decision was made, so
           nothing can check it held.
Done when: I am told when a thing I stopped charges me again — without having
           to remember to look.
Serves:    progress towards goals

## Making the categories true

Waste is invisible without categories, so this is bought for the aim above
rather than wanted for itself. The design question is how little of it is
needed.

## J-8 — Make an uncategorised pile small enough to ignore

Role:      bookkeeper
Frequency: monthly · twenty minutes
Story:     When enough spending is unattributed that the categories stop meaning
           anything, I want to clear the backlog by writing rules rather than
           filing rows one at a time, so the effort falls as the ledger grows.
Today:     Served, and it is the most developed part of the application: search,
           select, propose a rule, preview what it would change, apply. Backlog
           reporting names what is uncovered and what recurs.
Done when: A month's new spending needs minutes, not an evening.
Serves:    progress towards goals

## J-9 — Correct one transaction without writing a rule about it

Role:      bookkeeper
Frequency: weekly · seconds
Story:     When a single transaction is filed wrongly and nothing general
           explains it, I want to name it directly, so one oddity does not
           become a rule that mis-files things later.
Today:     Served. Overrides are a set of their own, authored, outranking every
           other. A correction cannot be regenerated away.
Done when: The correction sticks, and does not affect anything else.
Serves:    progress towards goals

---

# Planning goals

**No jobs yet, and that is the finding rather than an omission.**

Nothing forward-looking exists anywhere in the system. Every figure is derived
from a transaction that already happened, which is the design's whole character
and the reason it can be deterministic and rebuildable. A goal points the other
way: a target, a date, a projection, a gap.

Writing the jobs for this means deciding what a household actually does with a
goal once it has one — which is a conversation that has not happened, not a
backlog item.

---

# Keeping it trustworthy

These serve all three aims, because none of them is worth anything if the
ledger is stale or wrong.

## J-12 — Keep the feed alive

Role:      operator
Frequency: every ninety days · minutes, but with a deadline
Story:     When a bank consent is about to lapse, I want to be told in time and
           be able to renew it, so the ledger does not go quietly stale.
Today:     Partly served. Expiry is computed, surfaced above everything else,
           and thresholds are configurable. Nothing renews it, and no warning
           reaches anyone who is not already looking at the screen — #69, #67.
Done when: A lapse is something I am told about, not something I discover.
Serves:    all three

## J-13 — Satisfy myself the ledger matches reality

Role:      operator
Frequency: occasionally, and after anything surprising · minutes
Story:     When a figure here disagrees with what the bank shows, I want to find
           out which is wrong, so I know whether to fix the data or my
           expectation.
Today:     Served, and it found real defects: the running-balance check compares
           our derived position against the provider's own per-day and names the
           transactions that displace. It sits at the bottom of the household's
           main page, which is not where it belongs.
Done when: I can answer "does this match" and, if not, "which rows".
Serves:    all three

## J-14 — Add a bank without losing history

Role:      operator
Frequency: once per account, ever · minutes, unrepeatable
Story:     When I connect a bank, I want the deepest history it will ever give
           us captured at that moment, because the window shuts within the hour
           and never reopens.
Today:     Served, and designed around this: the first sync starts immediately
           rather than waiting for the schedule, raw responses land in S3 first
           so the ledger can be rebuilt, and per-account retries mean one
           failure does not cost the lot.
Done when: Years of history are present, and I never had to know there was a
           deadline.
Serves:    all three

---

# Steps, not jobs

Kept here rather than deleted, because the reasoning is worth preserving and
the call is arguable. None passes the test above: you do not set out to do any
of them, and having done one you are still mid-task.

- **Preview what a rule would do before applying it** — a step of clearing the
  backlog. Already specified where it matters: `preview.test.ts` describes what
  is gained, lost, recategorised, unchanged and outranked.
- **Say what a category means** — a step of creating one, which happens inside
  correcting or clearing.
- **Know the figures are current** — a precondition for everything rather than
  something anyone sets out to do. It belongs in how every view behaves, not in
  one job.

---

# What this says about the current design

**One surface serves two modes that want opposite things.** Every job above is
answered on the same scrolling page, in the order the features were written:
householder, connect, categorise, diagnostics, transactions. A glance and a
review get the same entry point, the same density, and the same five API calls
on load.

**Two of the three aims have nothing behind them.** `where do we stand` is
mostly built and is the best part of the application. `progress towards goals`
has no goals to progress against, and net worth is computable but not yet
truthful — a mortgage falls only by what is repaid, because interest is never
posted. `planning goals` has nothing at all.

**The lever is built and pointed the wrong way.** `detectRecurring` already
finds what repeats, and feeds rule-writing rather than a spending decision. The
most compounding form of waste is already detectable and is not shown to the
person who would act on it.

**The best-built parts are bought for an aim that does not exist yet.**
Preview, precedence, overrides and backlog are careful, tested and genuinely
good. They make the categories true, and categories are for finding waste,
which serves an aim with no goals in it. That was the right order to build in;
it also means the most machinery sits behind the least interface.
