# Dashboard

Behaviour of the household's main page, against a deployed environment.

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

Job: **J-1** — know where we stand · Covered: **no**

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

## Not behaviour

`dashboard.spec.ts` also asserts that the browser made no request outside the
environment under test. That is a property of the harness rather than of the
product, so it has no scenario here — but it belongs in the same file, because a
confinement nothing checks is a claim rather than a guard.
