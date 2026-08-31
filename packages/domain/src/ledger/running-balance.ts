/**
 * What `running_balance` means, checked rather than assumed.
 *
 * Three places already assume it is the balance **after** the transaction — a
 * closing position: `accountSeries` takes the last one on or before a day as
 * that day's balance, the card path subtracts everything dated after a day, and
 * reconciliation's window is exclusive of the earlier reading's day and
 * inclusive of the later's. Nothing states the assumption and nothing tests it.
 *
 * The provider does not settle it either. `running_balance` carries no
 * description in the API reference and is absent from the `required` array; the
 * guide says only "if available, contains the running balance". So the meaning
 * has to be recovered from the data.
 *
 * **Nothing we already run would catch it being wrong.** Reconciliation compares
 * balance *readings* against summed amounts and never looks at
 * `running_balance`. Once positions are derived from it (#108 step 2) a
 * misreading becomes a constant offset, and a constant offset cancels in the
 * difference between two readings — so every balance on the chart could be out
 * by one transaction with reconciliation staying green.
 */

import type { Movement } from "../reporting/balances.js";

/**
 * Which reading of `running_balance` the data supports.
 *
 * `ambiguous` is not a failure: it is what a ledger says when every consecutive
 * pair happens to carry the same amount, so both readings predict the same
 * chain. `inconsistent` means neither holds, which is a different and worse
 * thing — the chain itself is broken, and no interpretation rescues it.
 */
export type RunningBalanceVerdict =
  | "closing"
  | "opening"
  | "ambiguous"
  | "inconsistent"
  | "insufficient";

export interface ChainCheck {
  readonly verdict: RunningBalanceVerdict;
  /** Consecutive pairs where both rows carried a running balance. */
  readonly pairs: number;
  /**
   * Pairs the two readings disagree about, which are the only ones that carry
   * information. A pair whose two amounts are equal satisfies both.
   */
  readonly discriminating: number;
  readonly closingMatches: number;
  readonly openingMatches: number;
}

/**
 * Test both readings against one account's movements.
 *
 * One account at a time: two accounts interleaved share no chain, and mixing
 * them would manufacture breaks out of nothing.
 */
export function checkRunningBalanceChain(
  movements: readonly Movement[],
): ChainCheck {
  // The ledger's own order, matching `accountSeries`: within an account every
  // timestamp can be midnight, so the dedup key is what makes it total.
  const rows = [...movements]
    .filter((m) => m.runningBalance !== undefined)
    .sort((a, b) =>
      a.timestamp === b.timestamp
        ? a.dedupKey.localeCompare(b.dedupKey)
        : a.timestamp < b.timestamp
          ? -1
          : 1,
    );

  let pairs = 0;
  let discriminating = 0;
  let closingMatches = 0;
  let openingMatches = 0;

  for (let i = 1; i < rows.length; i++) {
    const previous = rows[i - 1]!;
    const current = rows[i]!;
    const step = current.runningBalance! - previous.runningBalance!;
    pairs += 1;

    const closing = step === current.amount;
    const opening = step === previous.amount;
    if (closing) closingMatches += 1;
    if (opening) openingMatches += 1;
    // Equal amounts satisfy both readings and tell you nothing.
    if (current.amount !== previous.amount) discriminating += 1;
  }

  return {
    verdict: verdictOf({ pairs, discriminating, closingMatches, openingMatches }),
    pairs,
    discriminating,
    closingMatches,
    openingMatches,
  };
}

function verdictOf(counts: {
  pairs: number;
  discriminating: number;
  closingMatches: number;
  openingMatches: number;
}): RunningBalanceVerdict {
  if (counts.pairs === 0) return "insufficient";
  // Every pair must hold. One exception is a broken chain, not a minority view:
  // a missing transaction breaks the chain wherever it sits, and calling the
  // majority the answer would bury exactly the defect worth finding.
  const closing = counts.closingMatches === counts.pairs;
  const opening = counts.openingMatches === counts.pairs;
  if (closing && opening) return "ambiguous";
  if (closing) return "closing";
  if (opening) return "opening";
  return "inconsistent";
}

/**
 * One day's arithmetic, which is the form a person can check by eye.
 *
 * If a running balance is a closing position then a day's closing less the
 * previous day's closing is exactly that day's movement. Same claim as
 * `checkRunningBalanceChain` aggregated to days — weaker, because offsetting
 * errors within a day cancel — but it is the version worth showing, since a
 * reader can verify one row against a statement.
 */
export interface DayCheck {
  readonly date: string;
  /** The last running balance on this day. */
  readonly closing: number;
  /** The last running balance on the most recent earlier day that had one. */
  readonly previousClosing: number;
  /** The sum of this day's amounts. */
  readonly movement: number;
  /** `(closing - previousClosing) - movement`. Zero when the day agrees. */
  readonly difference: number;
}

/** Day-level checks for one account, oldest first. The first day has nothing to compare against. */
export function dailyPositionChecks(
  movements: readonly Movement[],
): DayCheck[] {
  const withBalance = [...movements]
    .filter((m) => m.runningBalance !== undefined)
    .sort((a, b) =>
      a.timestamp === b.timestamp
        ? a.dedupKey.localeCompare(b.dedupKey)
        : a.timestamp < b.timestamp
          ? -1
          : 1,
    );

  const byDay = new Map<string, { closing: number; movement: number }>();
  for (const m of withBalance) {
    const date = m.timestamp.slice(0, 10);
    const day = byDay.get(date) ?? { closing: 0, movement: 0 };
    // Last wins: the rows are in ledger order, so the final one is the close.
    day.closing = m.runningBalance!;
    day.movement += m.amount;
    byDay.set(date, day);
  }

  const dates = [...byDay.keys()].sort();
  const out: DayCheck[] = [];
  for (let i = 1; i < dates.length; i++) {
    const date = dates[i]!;
    const day = byDay.get(date)!;
    const previousClosing = byDay.get(dates[i - 1]!)!.closing;
    out.push({
      date,
      closing: day.closing,
      previousClosing,
      movement: day.movement,
      difference: day.closing - previousClosing - day.movement,
    });
  }
  return out;
}
