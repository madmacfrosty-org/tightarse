/**
 * From what date is a household total trustworthy?
 *
 * Not "when does the oldest transaction start". Accounts were connected at
 * different times and providers serve wildly different depths — measured here,
 * from one bank and one consent: 60 months on the current accounts and 18 on
 * the credit card. A total drawn before an account's data begins silently omits
 * that account, and for a card it omits debt, so the line reads high and looks
 * entirely plausible.
 *
 * The test is whether the account **existed** before its earliest transaction,
 * not whether we happen to hold data. An account opened inside the range starts
 * at zero and is complete: it contributes nothing before it existed, and it
 * must not shorten the chart. One whose earliest balance is non-zero had money
 * or debt we cannot see, and it must.
 *
 * That distinction is derivable, which is the point — no per-account
 * configuration, nothing for anyone to keep up to date, and it stays correct
 * the first time a genuinely new account is opened.
 */

import type { AccountFacts, Movement } from "./balances.js";

/**
 * Below this, an opening balance counts as zero.
 *
 * A pound, in minor units. Not exact zero: a card's opening balance is derived
 * by summing every transaction against today's balance, so a single missing
 * refund would leave a few pence and flip the verdict. A pound is far below any
 * real opening balance and far above any rounding.
 */
const ZERO_TOLERANCE = 100;

export interface AccountCoverage {
  readonly accountId: string;
  /** Earliest date this account has data for, or undefined if it has none. */
  readonly historyFrom?: string | undefined;
  /**
   * True when the account was opened within the data we hold, so nothing is
   * missing before `historyFrom`. False when it plainly existed earlier.
   *
   * Absent means NOT KNOWN — an account with no transactions at all, where
   * there is no earliest balance to test. Same rule as `isCard` in #29, and for
   * the same reason: reporting `false` would state that history is missing when
   * what we mean is that there is nothing to say.
   */
  readonly historyComplete?: boolean | undefined;
}

/**
 * The balance immediately before an account's first transaction.
 *
 * Current accounts: the first transaction's running balance, less its own
 * amount. Cards: today's balance plus every transaction, which unwinds the
 * account back to its start — the same arithmetic reconciliation runs.
 *
 * `undefined` when it cannot be determined, which must never be read as zero:
 * "we cannot tell" is not "the account opened here".
 */
export function openingBalance(
  account: AccountFacts,
  movements: readonly Movement[],
): number | undefined {
  if (movements.length === 0) return undefined;
  // Same ordering as the series, and for the same reason: the first
  // transaction of the earliest day decides a current account's opening
  // balance, so "first" has to mean the same thing every time.
  const rows = [...movements].sort((a, b) =>
    a.timestamp === b.timestamp ? a.dedupKey.localeCompare(b.dedupKey) : a.timestamp < b.timestamp ? -1 : 1,
  );

  if (account.isCard === true) {
    if (account.currentBalance === undefined) return undefined;
    return account.currentBalance + rows.reduce((s, r) => s + r.amount, 0);
  }

  const first = rows[0]!;
  if (first.runningBalance === undefined) return undefined;
  return first.runningBalance - first.amount;
}

export function coverageOf(
  account: AccountFacts,
  movements: readonly Movement[],
): AccountCoverage {
  if (movements.length === 0) {
    // No data at all, so nothing to test and nothing to report. It has no start
    // date either, so it cannot constrain a range — there is nothing that could
    // be missing before a date that does not exist.
    return { accountId: account.accountId };
  }
  const historyFrom = movements.reduce(
    (min, m) => (m.timestamp < min ? m.timestamp : min),
    movements[0]!.timestamp,
  ).slice(0, 10);

  const opening = openingBalance(account, movements);
  return {
    accountId: account.accountId,
    historyFrom,
    // Undefined opening balance means we cannot tell, and the safe reading of
    // "cannot tell" is that history is missing.
    historyComplete: opening !== undefined && Math.abs(opening) < ZERO_TOLERANCE,
  };
}

/**
 * The earliest date at which a household total is complete.
 *
 * The latest start among accounts that are **incomplete**. Accounts opened
 * inside the data are excluded: they were genuinely absent before, so their
 * absence from a total is correct rather than a gap.
 *
 * `undefined` when nothing constrains the range — every account is complete, or
 * there are no accounts — and the caller may then use the full span.
 */
export function completeFrom(coverage: readonly AccountCoverage[]): string | undefined {
  const limiting = coverage
    .filter((c) => c.historyComplete !== true && c.historyFrom !== undefined)
    .map((c) => c.historyFrom!);
  return limiting.length === 0 ? undefined : limiting.reduce((a, b) => (a > b ? a : b));
}

/**
 * Narrow a requested range to what can honestly be drawn.
 *
 * Returns the range actually served. The caller reports it rather than quietly
 * returning less than was asked for — a client compares it against what it sent
 * to know it was clamped, and `completeFrom` tells it why.
 */
export function clampToCoverage(
  requested: { from: string; to: string },
  complete: string | undefined,
): { from: string; to: string } {
  if (complete === undefined || complete <= requested.from) return requested;
  // A range entirely before coverage collapses to nothing rather than
  // silently sliding forward into a period nobody asked about.
  return { from: complete > requested.to ? requested.to : complete, to: requested.to };
}
