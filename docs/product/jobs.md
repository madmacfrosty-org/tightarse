# What this is for

> **See the household's whole ledger, categorised, so that money being wasted
> becomes visible and can be stopped.**

Everything below ladders up to that sentence. A story that does not serve it
does not belong here, however good an idea it is.

## How to read this

Waste is not a fact in the data. £200 on groceries is not waste; £200 on
subscriptions nobody remembers is. So the software cannot find waste — it can
only surface **candidates**, and the household judges. That gives the aim a
shape, and most stories sit at one of its four steps:

```
detect  →  judge  →  act  →  confirm
```

`detect` is where the software does most of the work. `judge` is where it must
give enough context to decide. `act` happens outside this system entirely —
cancelling a subscription is done at the merchant. `confirm` is the step that
closes the loop, and the one nothing currently serves.

## Roles

The same person, in different circumstances, wanting different things.

| Role | What they are doing | Typical shape |
| --- | --- | --- |
| **householder** | Looking for the answer to a money question | Frequent, seconds, no learning expected |
| **bookkeeper** | Making the categories true, so the householder's figures mean something | Occasional, tens of minutes, model knowledge required |
| **operator** | Keeping the feed alive and the ledger honest | Rare, and about trust rather than money |

Bookkeeper and operator work exists to serve the householder. Categories are
**load-bearing** — waste is invisible without them — but the manual labour of
producing them is a cost, and the design question is how little of it is needed,
not how pleasant it can be made.

## Fields

`Today` is written honestly, including "not served". `Done when` is the
observable outcome — a story without one cannot be argued with, and is a wish.

---

# Householder

## J-1 — Know where we stand, right now

Role:      householder
Frequency: several times a week · seconds
Story:     When I wonder whether we are all right at the moment, I want one
           figure that accounts for every account and card, so I can stop
           wondering without doing arithmetic.
Today:     Served. Net position leads the page, derived from every book that
           rolls up, and says when it is incomplete rather than quietly
           understating.
Done when: I get the number without scrolling, and I believe it.
Serves:    the ground the rest of the loop stands on

## J-2 — Notice a cost that has crept up

Role:      householder
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
Serves:    detect — and this is the largest single gap against the aim

## J-3 — Find money leaving on repeat

Role:      householder
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
Serves:    detect — the highest-yield form of waste, because it compounds

## J-4 — Understand what a charge actually was

Role:      householder
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
Serves:    judge

## J-5 — Judge whether a cost is worth it

Role:      householder
Frequency: as prompted by J-2 or J-3 · minutes
Story:     When I am looking at something that might be waste, I want to see
           what it has cost over time and what it sits beside, so I can decide
           rather than guess.
Today:     Not served. A category total for the selected range exists; its
           history, its trend, and what it displaced do not.
Done when: I can answer "is this worth it" from one screen.
Serves:    judge

## J-6 — Confirm something actually stopped

Role:      householder
Frequency: monthly · seconds
Story:     When I have cancelled something, I want to be told whether it has
           actually stopped being charged, so a cancellation that silently
           failed does not cost me for another year.
Today:     Not served at all. Nothing records that a decision was made, so
           nothing can check it held.
Done when: I am told when a thing I stopped charges me again — without having
           to remember to look.
Serves:    confirm — the step that closes the loop, and the one wholly absent

## J-7 — Know whether the figures can be trusted today

Role:      householder
Frequency: every visit · glanced
Story:     When I look at any number here, I want to know it is current and
           complete, so I am not making decisions on a feed that quietly
           stopped.
Today:     Partly served. Consent expiry is warned about before anything else,
           and an incomplete range is stated rather than hidden. Whether the
           last sync actually succeeded is not shown.
Done when: A stale or partial ledger is obvious without my going to look for it.
Serves:    the precondition for every other story

---

# Bookkeeper

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
Serves:    the categories the whole aim depends on

## J-9 — Correct one transaction without writing a rule about it

Role:      bookkeeper
Frequency: weekly · seconds
Story:     When a single transaction is filed wrongly and nothing general
           explains it, I want to name it directly, so one oddity does not
           become a rule that mis-files things later.
Today:     Served. Overrides are a set of their own, authored, outranking every
           other. A correction cannot be regenerated away.
Done when: The correction sticks, and does not affect anything else.
Serves:    judge — a wrong category makes a real cost invisible

## J-10 — Trust that a rule change will not wreck last year

Role:      bookkeeper
Frequency: with every rule · a minute
Story:     When I write a rule, I want to see what it would do to the whole
           ledger before it does it, so improving this month does not silently
           rewrite a year I had already made sense of.
Today:     Served, and unusually well: a preview reports what is gained, lost,
           recategorised, unchanged and outranked, over the real corpus, before
           anything is written.
Done when: I can accept or reject a rule on evidence.
Serves:    the thing that makes bookkeeping affordable at all

## J-11 — Say what a category means, not just what it is called

Role:      bookkeeper
Frequency: rarely · minutes
Story:     When a category is not spending — a transfer, a savings pot, a loan
           repayment — I want to say so, so money that merely moved stops being
           reported as money spent.
Today:     Served in the model, barely in the UI. `nature` and `rollsUp` exist
           and the totals honour them; creating a category from the dashboard
           offers a nature, and nothing explains what the choice does.
Done when: A new category lands in the right half of the ledger without my
           knowing the model.
Serves:    the correctness of every spending figure — #109 was this failing

---

# Operator

## J-12 — Keep the feed alive

Role:      operator
Frequency: every ninety days · minutes, but with a deadline
Story:     When a bank consent is about to lapse, I want to be told in time and
           be able to renew it, so the ledger does not go quietly stale.
Today:     Partly served. Expiry is computed, surfaced above everything else,
           and thresholds are configurable. Nothing renews it, and no warning
           reaches anyone who is not already looking at the screen — #69, #67.
Done when: A lapse is something I am told about, not something I discover.
Serves:    the precondition for J-7, and for the data existing at all

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
Serves:    trust — without it, every other story rests on nothing

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
Serves:    the ledger's reach — a job that can only be done wrong once

---

# What this says about the current design

Three observations fall out of the table rather than out of opinion.

**The loop is open.** `detect` is thin, `judge` is thin, and `confirm` does not
exist. The application is good at *reporting what happened* and has almost
nothing for *noticing what changed* or *checking that something stopped*. J-2,
J-3 and J-6 are the aim's own steps and none is served.

**The best-built parts serve the bookkeeper.** Preview, precedence, overrides
and backlog are careful, tested and genuinely good. They are in service of a
householder experience that has one figure and three static charts. The effort
has gone into making the categories true, which was the right order — but the
thing they were made true *for* has not been built yet.

**Roles share one surface.** Every story above is answered on the same scrolling
page, in the order the features were written: householder, then operator
(connect), then bookkeeper (categorise), then operator again (diagnostics), then
householder (transactions). A job done several times a week and one done once
per account, ever, are given equal billing.
