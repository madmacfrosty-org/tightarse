# Home

Behaviour of the page at `/`, against a deployed environment.

The glance: position, how it has moved, and the transactions behind it. It asks
nothing before it answers — the range selector belongs to `/spending`, because a
period is a question about reviewing and a position is a statement about now.

Executed by [`home.spec.ts`](../tests/home.spec.ts). Each scenario
names the job it serves, from
[`docs/product/jobs.md`](../../docs/product/jobs.md), and says whether that
behaviour is `implemented` or `proposed`.

Nothing here records which tests exist. A spec describes behaviour; what covers
it is a question for the test suite, answered by comparing the two rather than
by keeping a tally in both places.

## Starting state

Every scenario assumes:

- A signed-in session, established once by `auth.setup.ts` and reused
- A ledger with at least one account and some settled transactions

Scenarios are independent and may run in any order. None writes anything, so
none can disturb another.

---

## 1. The net position is the figure the API sent

Job: **J-1** — know where we stand
Status: **implemented**

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

## 2. An incomplete history says so rather than understating

Job: **J-1** — know where we stand
Status: **implemented**

1. Open the dashboard with a ledger where at least one account has shallower
   history than the range asked for.
2. Read the summary.

**Expected:** the page states that the total is trustworthy only from a given
date, rather than presenting a figure that silently omits the earlier part.

**Succeeds when** the constraint is visible without going to look for it.

**Fails when** a partial total renders as though complete. A figure that is
quietly short looks exactly like one that is right.

---

## 3. A consent near expiry is warned about before anything else

Job: **J-9** — keep the feed alive
Status: **implemented**

1. Open the dashboard with a consent inside the warning threshold.
2. Read the top of the page.

**Expected:** the warning appears above the figures, naming the institution and
when it lapses.

**Succeeds when** the notice is the first thing on the page.

**Fails when** it is absent or below the numbers. Consent has a deadline and the
figures do not; if the feed stops, every figure goes stale while still looking
correct.

---

## 4. The transaction list shows more on request

Job: **J-2** — understand what a charge was
Status: **implemented**

1. Open the dashboard with more than one hundred transactions in range.
2. Scroll to the transaction list.
3. Use the control offering more.

**Expected:** the first hundred are listed, with a control saying how many more
remain; using it extends the list in place.

**Succeeds when** the count offered matches what is actually added.

**Fails when** rows are truncated with no indication, which hides spending rather
than deferring it.

---


## 5. The glance covers three months, ending where it is pinned

Job: **J-1** — know where we stand
Status: **proposed**

1. Open `/?at=2026-06-30` against a ledger with more than a year of history.
2. Read the balance line and the transaction list.

**Expected:** both cover the three months ending 30 June 2026. The position
shown is the position at that date, not today's.

**Succeeds when** every figure on the page describes the same moment.

**Fails when** the position is current while the line and the list are
historical. A page showing two different times is worse than one showing the
wrong time, because nothing on it says which.

---

## 6. The window has no control

Job: **J-1** — know where we stand
Status: **implemented**

1. Open `/`.
2. Look for a way to change the period.

**Expected:** there is none. The pin comes from `?at=`, defaulting to today.

**Succeeds when** the page asks nothing before answering.

**Fails when** a range selector appears. Choosing a window is reviewing, and
reviewing has its own page — this was the control that turned one page into
something you had to operate before you could read it.

---

## 7. The transactions on the glance are searchable

Job: **J-2** — understand what a charge actually was
Status: **proposed**

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

`home.spec.ts` also asserts that the browser made no request outside the
environment under test. That is a property of the harness rather than of the
product, so it has no scenario here — but it belongs in the same file, because a
confinement nothing checks is a claim rather than a guard.
