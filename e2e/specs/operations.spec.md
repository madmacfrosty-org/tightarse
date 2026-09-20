# Operations

Behaviour of the page at `/operations`, against a deployed environment.

Connections, consents, and whether the ledger matches the bank. Rare work, and
about trust rather than money.

To be executed by `tests/operations.spec.ts`, which does not exist yet. Each
scenario names the job it serves, from
[`docs/product/jobs.md`](../../docs/product/jobs.md).

## Starting state

A signed-in session and at least one connection.

**Scenario 2 must never be run to completion against a real bank.** Starting a
connection is not reversible in the way tests assume: roughly an hour after an
authorisation, only ninety days of history remain available, for ever. The
scenario asserts the browser leaves for the provider and stops there.

---

## 1. Every connection says how long it has left

Job: **J-9** — keep the feed alive · Covered: **no**

1. Open `/operations`.
2. Read the connections.

**Expected:** each names its institution, when its consent lapses, and how many
days that is.

**Succeeds when** the state of every connection can be read in one place,
whether or not any of them is urgent.

**Fails when** a connection is missing, or its expiry is only shown once it is
nearly too late. The warning on `/` is for when it becomes urgent; this is for
when you want to check rather than be told.

---

## 2. Starting a connection leaves for the provider

Job: **J-11** — add a bank without losing history · Covered: **no**

1. Open `/operations`.
2. Begin connecting a bank.

**Expected:** the browser is sent to the provider's consent screen, at the
provider's own origin.

**Succeeds when** the departure happens and the test stops there.

**Fails when** nothing happens, or the browser goes somewhere else. This is the
one flow where completing it in a test would do real harm — see the note above.

---

## 3. The ledger can be checked against the bank

Job: **J-10** — satisfy myself the ledger matches reality · Covered: **no**

1. Open `/operations`.
2. Run the check.

**Expected:** a verdict per account, and where they disagree, the transactions
that displace the balance.

**Succeeds when** a disagreement names the rows causing it.

**Fails when** the answer is only that something is wrong. "It does not match"
without naming rows is a worry rather than a finding, and this check exists
because it found real ones.

---

## 4. Nothing here is on the household's way

Job: **J-9**, **J-10**, **J-11** · Covered: **no**

1. Open `/`.

**Expected:** no connection list, no reconciliation control, and no way to
begin connecting a bank. Only a consent warning, and only when one is urgent.

**Succeeds when** the glance is unaffected by work nobody does weekly.

**Fails when** operator tools appear on the page opened to answer a money
question. That is how the original single page grew a running-balance
diagnostic between the books and the transaction list.
