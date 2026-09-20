# Dashboard

Behaviour of the page at `/`, against a deployed environment.

It is becoming the glance — position, how it has moved, and three months of
transactions you can search. Scenarios 1 to 5 describe the page as it is today;
6 to 8 describe what it becomes when the routing in
[`routing.spec.md`](routing.spec.md) lands. This file should be renamed
`glance.spec.md` at that point, once `/spending`, `/categories` and
`/operations` have specs of their own.

Executed by [`dashboard.spec.ts`](../tests/dashboard.spec.ts). Each scenario names the
job it serves, from [`docs/product/jobs.md`](../../docs/product/jobs.md), and
says whether a test covers it today. A scenario with no test is a statement of
intent, not a claim about what works.

## Starting state

Every scenario assumes:

- A signed-in session, established once by `auth.setup.ts` and reused
- A ledger with at least one account and some settled transactions
- The default range, twelve months

Scenarios are independent and may run in any order. None writes anything, so
none can disturb another.

---

## 1. The net position is the figure the API sent

Job: **J-1** — know where we stand · Covered: **yes**

1. Open the dashboard.
2. Capture the response to `GET /books` that the page itself made.
3. Read the net position shown under the heading.

**Expected:** the figure on screen is `householdPosition` from that response,
formatted as sterling, with a minus sign where negative.

**Succeeds when** the rendered figure and the API's figure are the same number.

**Fails when** they differ — which means the dashboard and the API disagree, and
is the one failure no component test can see. Comparing against a second request
would not do: a later call could be answered differently, and the test would be
checking the page against something the page never saw.

---

## 2. The range selector changes what is reported

Job: **J-1** — know where we stand · Covered: **no** · **Goes away**

Describes today. Scenario 7 replaces it: the glance is pinned and has no
control, and choosing a window becomes reviewing.

1. Open the dashboard.
2. Note the transaction count in the summary.
3. Choose **3 months**.
4. Note the count again.

**Expected:** the figures reload and describe the shorter window. Net position is
a statement about now and does not change with the range; income, spending and
the category breakdown do.

**Succeeds when** the range-dependent figures change and the net position does
not.

**Fails when** net position moves with the range — it would mean a position is
being computed from the window rather than from every transaction, which
understates what the household holds.

---

## 3. An incomplete history says so rather than understating

Job: **J-1** — know where we stand · Covered: **no**

1. Open the dashboard with a ledger where at least one account has shallower
   history than the range asked for.
2. Read the summary.

**Expected:** the page states that the total is trustworthy only from a given
date, rather than presenting a figure that silently omits the earlier part.

**Succeeds when** the constraint is visible without going to look for it.

**Fails when** a partial total renders as though complete. A figure that is
quietly short looks exactly like one that is right.

---

## 4. A consent near expiry is warned about before anything else

Job: **J-9** — keep the feed alive · Covered: **no**

1. Open the dashboard with a consent inside the warning threshold.
2. Read the top of the page.

**Expected:** the warning appears above the figures, naming the institution and
when it lapses.

**Succeeds when** the notice is the first thing on the page.

**Fails when** it is absent or below the numbers. Consent has a deadline and the
figures do not; if the feed stops, every figure goes stale while still looking
correct.

---

## 5. The transaction list shows more on request

Job: **J-2** — understand what a charge was · Covered: **no**

1. Open the dashboard with more than one hundred transactions in range.
2. Scroll to the transaction list.
3. Use the control offering more.

**Expected:** the first hundred are listed, with a control saying how many more
remain; using it extends the list in place.

**Succeeds when** the count offered matches what is actually added.

**Fails when** rows are truncated with no indication, which hides spending rather
than deferring it.

---


## 6. The glance covers three months, ending where it is pinned

Job: **J-1** — know where we stand · Covered: **no**

1. Open `/?at=2026-06-30` against a ledger with more than a year of history.
2. Read the balance line and the transaction list.

**Expected:** both cover the three months ending 30 June 2026. The position
shown is the position at that date, not today's.

**Succeeds when** every figure on the page describes the same moment.

**Fails when** the position is current while the line and the list are
historical. A page showing two different times is worse than one showing the
wrong time, because nothing on it says which.

---

## 7. The window has no control

Job: **J-1** — know where we stand · Covered: **no**

1. Open `/`.
2. Look for a way to change the period.

**Expected:** there is none. The pin comes from `?at=`, defaulting to today.

**Succeeds when** the page asks nothing before answering.

**Fails when** a range selector appears. Choosing a window is reviewing, and
reviewing has its own page — this is the control that turned the original
single page into something you had to operate before you could read it.

---

## 8. The transactions on the glance are searchable

Job: **J-2** — understand what a charge actually was · Covered: **no**

1. Open `/`.
2. Search the transaction list for a description you half-remember.

**Expected:** the list narrows to matching transactions within the three
months. Nothing about rules or categorisation is involved.

**Succeeds when** you can find one transaction without leaving the page you
landed on.

**Fails when** finding a charge means entering the categorisation workflow,
which is where search lives today. That asks a householder to enter a
bookkeeper's tool to answer "what was that forty pounds".

---

## Not behaviour

`dashboard.spec.ts` also asserts that the browser made no request outside the
environment under test. That is a property of the harness rather than of the
product, so it has no scenario here — but it belongs in the same file, because a
confinement nothing checks is a claim rather than a guard.
