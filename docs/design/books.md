# Books

What a category actually is, and why the ledger is about to be described in
terms of books and transfers. Written before the code, so the reasoning survives
the implementation.

This describes a model being **moved to**, not the one in place. See
[#108](https://github.com/madmacfrosty-org/tightarse/issues/108) for the work.

Examples are invented. Merchants are real household data and
[do not go in files](../../CONTRIBUTING.md#this-repository-is-public).

## The problem

Money the household did not spend is counted as spending, and money it owes is
not counted at all.

A loan repayment leaves the current account, so it is spend. It is not — most of
it retires a debt, and only the interest is a cost. The same is true of anything
moved to an account we do not hold: savings elsewhere, an unconnected card, money
lent to a person.

Today the only thing excluded from a total is a **detected internal transfer**,
which pairs a debit in one account against a credit in another. Both sides have
to be in the ledger. When the other side is an account we do not hold, there is
nothing to pair with, and the money reads as gone.

That detection stops being necessary. It exists because the summary adds raw
amounts by sign rather than by book — `detectTransfers` produces a set of keys
purely so the sum can skip them. Once money between two held accounts is legs in
two asset books, it never enters a spending flow at all, and a heuristic that is
deliberately conservative because "a false positive silently erases real
spending" is replaced by the model being right.

The obvious remedy does not work either. `CategoryKind` exists, describes itself
as "the only thing code may branch on… because totals depend on it", and nothing
branches on it: `summarise` never receives the catalogue. Marking a category as a
movement changes no figure.

## The model

Every transaction has two sides. One is the bank account it crossed. The other is
whatever it was for — and **that is what categorising records**. Filing something
as Groceries says its other leg went to the Groceries book.

So the second leg already exists. Every categorisation is one. What has never
existed is a position for those books.

```mermaid
erDiagram
    BOOK ||--o{ LEG : accumulates
    TRANSFER ||--|{ LEG : "balances to zero"
    TRANSACTION ||--|{ TRANSFER : "gives rise to"
    RULE ||--o{ TRANSFER : "gives rise to"
    BOOK ||--o| ACCOUNT : "is one, when we hold it"
    BOOK ||--o| LOAN : "is one, when it accrues"
    RULE_SET ||--|{ RULE : contains
    RULE }o--|| BOOK : "moves into"
```

**Book** — a named place legs accumulate. A bank account is a book; so is a
category; so is a loan.

**Leg** — one side of one transfer: an amount into a book, with the date it
applies and the date we recorded it.

**Transfer** — the legs that balance to zero. A transaction arriving is a
transfer of two legs: the account, and the book named by the provider's own
category. A rule firing is another: out of that book, into ours.

Every transfer balances. That is an invariant rather than part of the name, and
it can never be false — so a transfer that does not is a defect, not a variety.

**Transaction** — the bank's fact. It gives rise to transfers; it is not one.

**Account** and **Loan** are what a book additionally *is*, when it is one.
Neither is a separate thing to move money into.

### Money arriving

An arrival looks like it has only one side. It does not: money entering the
ledger is a transfer from the book standing for the outside world, which is the
one named by the provider's own category. That is what makes the books balance
even before anybody has categorised anything.

## Position and flow are the same arithmetic

A book's **position** is the running sum of its legs. Its **flow** between two
dates is the difference between the positions at those dates.

Groceries has a position — everything ever spent on food — and a flow, what was
spent in March. A loan has a position, what is owed, and a flow, what was repaid
in March. There is no second kind of book.

What separates them is the book's **nature**: `asset`, `liability`, `income` or
`expense`. Assets and liabilities have positions that are part of what the
household is worth; income and expense do not. A current account is an asset, a
loan is a liability, Groceries is an expense, a salary is income.

One field, and it answers two questions — whether a position rolls up into the
household total, and which way it counts. A boolean would have answered the first
and left the second somewhere else.

This is what `CategoryKind` was reaching for and did not reach: `spending`,
`income` and `movement` conflate a payment to an account we hold with one to an
account we do not, and those are different books entirely.

It also collapses two computations into one. `summarise` produces flows per
category over a range; `netPositionSeries` produces levels per account over time.
Both are running sums over books, asked different questions.

## Nothing is uncategorised

A transaction arrives into the book named by the provider — `PURCHASE`,
`DIRECT_DEBIT` — and a rule transfers it out into one of ours. The books
therefore always balance, and what has been called the backlog is a balance
sitting in provider books rather than an absence of data.

This is worth more than tidiness: it is checkable. If the two sides do not sum to
zero, something is wrong with the ledger rather than with somebody's filing.

## Stored, and derived

The division is what keeps re-application total.

**Stored**: the bank's transactions; the rule sets and their versions; a small
record per book — its label, its nature, an opening position where one was never
transacted, and for a loan its basis.

**Derived**: every leg, every transfer, and therefore every position and every
flow. They are a function of the transactions and the rules, recomputed rather
than kept.

A correcting transfer is derived too. Recategorising does not write a correction;
it changes what the rules say, and the legs follow. Anything else would mean
re-running the rules no longer reproduces the ledger, and two records that can
disagree.

## Two dates, not one

A leg **applies at** the original transaction's date, so improving a rule
corrects March's food figure. It is **recorded at** the moment the rule ran, so
what March said in April remains answerable.

Two, not three. Which pair coincides differs by leg, which is why three looks
necessary: a rule transfer applies when the money moved and is recorded when the
rule ran, while an interest accrual has no bank fact at all and applies in the
month it accrued. So `appliesAt` is **inherited** where there is a transaction
behind it and **chosen** where there is not.

Both axes are already stored — a transaction has its `timestamp`, a
categorisation has `appliedAt`, superseded rows are retained — and nothing
queries the second. Every read silently means "as we understand things now".

Making the second axis real turns the risk stated plainly in
[categorisation.md](categorisation.md#the-risk-worth-stating-plainly) — "a figure
someone looked at last month quietly saying something different now" — into
something the system can show rather than only warn about. The figure did not
quietly change; it changed on the day that rule was accepted, and here is what it
said before.

## Deliberately elsewhere

**Interest** is the one leg no bank ever reports: a lender charges it against
the loan book and nothing crosses the current account. It needs a basis to be
derived from, and it is [#110](https://github.com/madmacfrosty-org/tightarse/issues/110).

**Portfolios** — several books viewed as one — are
[#111](https://github.com/madmacfrosty-org/tightarse/issues/111). A book must be
able to sit in more than one, which is the reason they are not simply broader
categories.

## The cost, stated plainly

A transaction has one category, so it lives in exactly one book. That is right for
a loan repayment, and it forbids something a real chart of accounts allows:
splitting one payment across two books. Part-personal, part-business, or a shop
where half the basket was food and half was hardware, cannot be expressed.

Accepted rather than solved. Splitting would mean a transaction with several
categorisations, which changes what a categorisation is and what a rule produces,
and no case has yet been worth that.
