# Categories

Behaviour of the page at `/categories`, against a deployed environment.

Keeping categories accurate. All of it exists today, inside the single page;
none of it is tested in a browser.

To be executed by `tests/categories.spec.ts`, which does not exist yet. Each
scenario names the job it serves, from
[`docs/product/jobs.md`](../../docs/product/jobs.md).

## Starting state

A signed-in session, a ledger with uncategorised spending, and at least one
category the household has created.

Scenarios 3 and 4 **write**. They are the only scenarios in this suite that
change anything, and they are the reason the dev environment is synthetic.

---

## 1. Searching finds what a rule would match

Job: **J-7** — make an uncategorised pile small enough to ignore · Covered: **no**

1. Open `/categories`.
2. Search for a merchant, optionally narrowing by amount or by type.
3. Read the rows returned.

**Expected:** the rows are the debits the search describes, over the range.
Credits are left out: a refund is not something a spending rule should claim.

**Succeeds when** what is on screen is what a rule built from the same search
would take.

**Fails when** the search and the rule are built from different things. The
screen would then be showing one set of transactions and writing a rule about
another, which is only discovered after it has been applied.

---

## 2. A proposal says what it would do before it does it

Job: **J-7** — make an uncategorised pile small enough to ignore · Covered: **no**

1. Search, select rows, and choose a category.
2. Ask what the change would do, without applying it.

**Expected:** a report of what would be gained, lost, recategorised, left
unchanged, and outranked — measured over the real ledger, not the rows on
screen.

**Succeeds when** the decision to apply can be made on evidence.

**Fails when** a preview describes only the visible rows. A rule reaches the
whole ledger, so a preview that looks at this month can quietly rewrite a year
somebody had already made sense of.

---

## 3. Applying writes a version and recategorises

Job: **J-7** — make an uncategorised pile small enough to ignore · Covered: **no**

1. From a preview, confirm the change.
2. Read what the page reports afterwards.

**Expected:** a new version of the rule set is written and accepted, the ledger
is recategorised, and the page says how many transactions were affected.

**Succeeds when** the count reported matches what the preview predicted.

**Fails when** they differ. A preview that does not predict the outcome is
worse than none, because it was trusted.

---

## 4. One transaction can be named without writing a rule about it

Job: **J-8** — correct one transaction · Covered: **no**

1. Find a single transaction filed wrongly, where nothing general explains it.
2. Correct it directly.
3. Search for something the correction should not affect.

**Expected:** that transaction takes the new category and nothing else moves.

**Succeeds when** the correction sticks and is confined to the row it names.

**Fails when** correcting one row changes others. One oddity becoming a rule is
how a mis-filing spreads.

---

## 5. Creating a category asks what it does to the money

Job: **J-7** — make an uncategorised pile small enough to ignore · Covered: **no**

1. Create a new category from this page.

**Expected:** it cannot be created without saying what kind of thing it is —
whether money filed there has been spent, earned, or merely moved.

**Succeeds when** a new category lands on the right side of the ledger without
the household knowing the model.

**Fails when** everything defaults to spending. A savings category counted as
spending overstates outgoings by its whole balance, which is what #109 was.
