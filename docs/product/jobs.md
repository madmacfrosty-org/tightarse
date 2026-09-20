# Jobs

Every job here serves one of the three aims, defined in
[the FAQ](faq.md#what-is-it-for):

- **where do we stand**
- **progress towards goals**
- **planning goals**

A job that serves none of them does not belong here.

## Roles and modes

The **role** says what someone is doing. The **mode** says what good looks like.
They vary independently, and the householder works in two modes.

| Role | Doing what |
| --- | --- |
| **householder** | Asking a money question |
| **bookkeeper** | Keeping categories accurate, so the figures mean something |
| **operator** | Keeping the feed alive and the ledger honest |

| Mode | Triggered by | Succeeds when |
| --- | --- | --- |
| **glance** | Something outside — about to spend, a passing doubt | One answer, then closed |
| **review** | Yourself — "let us look at the finances" | A decision made |

Good means opposite things in the two modes. A glance that takes thirty seconds
has failed even when the figure is right; a review that answers with one big
number has failed even when it is instant. One surface cannot be optimised for
both, and the page that exists today is what happens when you try.

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

## J-2 — Understand what a charge actually was

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

## J-3 — Notice a cost that has crept up

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

## J-4 — Find money leaving on repeat

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
Frequency: as prompted by J-3 or J-4 · minutes
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

## Keeping categories accurate

## J-7 — Make an uncategorised pile small enough to ignore

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

## J-8 — Correct one transaction without writing a rule about it

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

No jobs yet.

---

# Keeping it trustworthy

These serve all three aims, because none of them is worth anything if the
ledger is stale or wrong.

## J-9 — Keep the feed alive

Role:      operator
Frequency: every ninety days · minutes, but with a deadline
Story:     When a bank consent is about to lapse, I want to be told in time and
           be able to renew it, so the ledger does not go quietly stale.
Today:     Partly served. Expiry is computed, surfaced above everything else,
           and thresholds are configurable. Nothing renews it, and no warning
           reaches anyone who is not already looking at the screen — #69, #67.
Done when: A lapse is something I am told about, not something I discover.
Serves:    all three

## J-10 — Satisfy myself the ledger matches reality

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

## J-11 — Add a bank without losing history

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
