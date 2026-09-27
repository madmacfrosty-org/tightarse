# Spending

Behaviour of the page at `/spending`, against a deployed environment.

Review mode: sitting down, tens of minutes, deciding something. Most of it is
moving from the single page; scenarios 5 and 6 are the jobs that make this aim
worth having and are not built.

To be executed by `tests/spending.spec.ts`, which does not exist yet. Each
scenario names the job it serves, from
[`docs/product/jobs.md`](../../docs/product/jobs.md).

## Starting state

A signed-in session and a ledger with settled transactions across more than one
month. The range is in the address — see `routing.spec.md`, scenario 4 — and
defaults to twelve months.

---

## 1. Income and spending describe the chosen range

Job: **J-3** — notice a cost that has crept up · Covered: **no**

1. Open `/spending`.
2. Read income, spending and the net of the two.
3. Choose a different range.

**Expected:** all three describe the selected period and change with it.

**Succeeds when** the figures and the range agree.

**Fails when** a figure ignores the range. This is the page where the range
means something — on `/` it does not exist, because a position is about now.

---

## 2. Transfers between our own accounts are netted, and said so

Job: **J-3** — notice a cost that has crept up · Covered: **no**

1. Open `/spending` over a period containing a transfer between two accounts
   the household holds.
2. Read the income and spending figures and the note beside them.

**Expected:** the transfer is in neither total, and the page says how much was
netted out.

**Succeeds when** the amount netted is stated rather than silently removed.

**Fails when** money moved between accounts is counted as both income and
spending. Before this existed it inflated five-year totals by more than half on
both sides — and a figure that quietly shrinks is indistinguishable from one
that was right.

---

## 3. Money that moved rather than went is excluded and counted

Job: **J-3** — notice a cost that has crept up · Covered: **no**

1. Open `/spending` over a period containing transactions filed to a category
   whose nature is an asset or a liability.
2. Read the note about what was left out.

**Expected:** those transactions are outside the spending total, and the page
says how many and how much.

**Succeeds when** the exclusion is visible.

**Fails when** they are silently dropped, or silently counted. Paying a card,
moving to savings and repaying a loan all leave an account, and counting them
as spending is the same error as counting a transfer, reached from the other
side.

---

## 4. Categories are ordered by what they cost, and unfinished ones marked

Job: **J-5** — judge whether a cost is worth it · Covered: **no**

1. Open `/spending`.
2. Read the category breakdown.

**Expected:** largest spending first, and any category standing in for the
provider's own label rather than a household rule is marked as provisional.

**Succeeds when** the biggest cost is at the top and nothing pretends to be
categorised that is not.

**Fails when** a provider label is presented as a household category. It makes
uncategorised spending look accounted for, which hides exactly the spending
worth looking at.

---

## 5. What changed since the period before

Job: **J-3** — notice a cost that has crept up · Covered: **no** · **Not built**

1. Open `/spending`.
2. Read the category breakdown.

**Expected:** each category shows how it compares with the previous period of
the same length, and the ones that moved most are findable without arithmetic.

**Succeeds when** the household can name the thing that changed.

**Fails when** every category is a bar with no history. This is the largest gap
against the aim: nothing in the application compares one period against
another, so a category that doubled looks like any other.

---

## 6. What is being paid for on repeat

Job: **J-4** — find money leaving on repeat · Covered: **no** · **Not built**

1. Open `/spending`.
2. Read what recurs.

**Expected:** costs that repeat are listed with what each is costing a year.

**Succeeds when** the household can go through them and decide on each.

**Fails when** recurrence is invisible. The detection already exists —
`detectRecurring` feeds rule-writing — so the most compounding form of waste is
already found and is not shown to the person who would act on it.

---

## J-6 has no scenario

Confirming that something stopped cannot be described yet, and the reason is
worth recording rather than leaving as a gap in the table.

It needs the application to know that a decision was made — that this cost was
looked at and cancelled — and nothing anywhere records that. Every figure here
is derived from transactions the bank reported; a decision is not one of those.
Until something holds it, there is nothing to check against, and a scenario
would be describing a mechanism rather than a behaviour.

It is the last step of the loop the aim implies — detect, judge, act, confirm —
and the only one with nothing behind it at all.
