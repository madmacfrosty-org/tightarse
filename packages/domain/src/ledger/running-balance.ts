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
import type { RecordedTransaction } from "./transaction.js";

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

  // Already ascending: `withBalance` is sorted by timestamp above and a Map
  // keeps insertion order, so the keys arrive in date order. Sorting again
  // would be a no-op that no test could distinguish from its absence.
  const dates = [...byDay.keys()];
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

/**
 * A transaction the check believes is dated wrongly, in enough detail to check.
 *
 * Carries the description and the merchant, which is the most personal thing in
 * the ledger. It is here because a reader has to recognise the row in their own
 * banking app to confirm it — a date and an amount are not enough to identify a
 * transaction by eye. This must never be logged, emitted as a metric, or put in
 * any output that is not the authenticated browser.
 */
export interface SuspectTransaction {
  readonly dedupKey: string;
  /** The date our ledger holds. Midnight, so effectively a date. */
  readonly timestamp: string;
  readonly description: string;
  readonly amount: number;
  readonly status: string;
  readonly merchantName?: string;
}

/**
 * Two days that disagree by equal and opposite amounts.
 *
 * A transaction absent from the ledger breaks exactly one day: the day check
 * compares the provider's own closing balances on both sides, so from the next
 * day on the error is present in both and cancels. Two days that are wrong by
 * the same amount in opposite directions are a different fault — a transaction
 * we do hold, counted once, filed under the wrong date. The bank moved on one
 * day; our ledger moved on the other.
 *
 * That distinction is the whole value of pairing them: one shape means data is
 * missing, the other means data is misplaced, and only the second can be shown
 * to a reader as a row they can go and look at.
 */
export interface Displacement {
  /** The day our ledger dates the transaction. */
  readonly ledgerDate: string;
  /** The day the provider's balance actually moved by this amount. */
  readonly bankDate: string;
  /** Whole days from the bank's date to ours. Negative when we date it earlier. */
  readonly displacedBy: number;
  /** The amount that moved on one day and not the other. */
  readonly amount: number;
  /**
   * Transactions on the ledger day whose amount is exactly this.
   *
   * Empty is a real answer and not a failure: it says the arithmetic pairs up
   * but we hold no single transaction that accounts for it, which points at
   * something absent rather than misdated. More than one means the amount alone
   * cannot pick between them, and guessing would be worse than showing both.
   */
  readonly candidates: readonly SuspectTransaction[];
}

/** Whole days since the epoch, for a `YYYY-MM-DD` date. */
function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

function asSuspect(t: RecordedTransaction): SuspectTransaction {
  return {
    dedupKey: t.dedupKey,
    timestamp: t.timestamp,
    description: t.description,
    amount: t.amount,
    status: t.status,
    ...(t.merchantName === undefined ? {} : { merchantName: t.merchantName }),
  };
}

/**
 * Pair up days that cancel each other out, and name the transaction between them.
 *
 * Nearest first. Where several days disagree by the same amount the pairing is
 * a choice rather than a deduction, and the nearest is the only defensible one
 * to make — a displacement of days is ordinary, one of years is not.
 *
 * A day is paired at most once, and a transaction can only match its own date,
 * so no two displacements can name the same row.
 */
export function displacements(
  days: readonly DayCheck[],
  transactions: readonly RecordedTransaction[],
): Displacement[] {
  const unexplained = days.filter((d) => d.difference !== 0);

  // Every pairing that cancels, closest first. Taking each day in turn and
  // giving it *its* nearest partner is not the same thing: with days nineteen
  // apart and two apart competing for the same partner, going in date order
  // hands it to the nineteen and leaves the obvious pair unmatched.
  const options: { a: DayCheck; b: DayCheck; apart: number }[] = [];
  for (let i = 0; i < unexplained.length; i++)
    for (let j = i + 1; j < unexplained.length; j++) {
      const a = unexplained[i]!;
      const b = unexplained[j]!;
      if (a.difference !== -b.difference) continue;
      options.push({
        a,
        b,
        apart: Math.abs(dayNumber(b.date) - dayNumber(a.date)),
      });
    }
  // No tiebreak: `unexplained` is in date order, so the pairs are generated in
  // date order too, and `sort` is stable. Comparing dates as well would be a
  // no-op that no test could distinguish from its absence.
  options.sort((x, y) => x.apart - y.apart);

  const paired = new Set<string>();
  const out: Displacement[] = [];

  for (const { a, b } of options) {
    if (paired.has(a.date) || paired.has(b.date)) continue;
    paired.add(a.date);
    paired.add(b.date);

    // The bank moved on whichever day gained value our transactions do not
    // account for. The other day is where our ledger put it.
    const bank = a.difference > 0 ? a : b;
    const ledger = a.difference > 0 ? b : a;
    const amount = bank.difference;
    const candidates = transactions
      .filter(
        (t) => t.timestamp.slice(0, 10) === ledger.date && t.amount === amount,
      )
      .map(asSuspect);

    out.push({
      ledgerDate: ledger.date,
      bankDate: bank.date,
      displacedBy: dayNumber(ledger.date) - dayNumber(bank.date),
      amount,
      candidates,
    });
  }
  // Oldest first, matching the day rows they explain. Pairing runs
  // closest-first, so `out` arrives in distance order rather than time order.
  return out.sort((x, y) => startOf(x).localeCompare(startOf(y)));
}

/** The earlier of a displacement's two days: where the fault begins. */
function startOf(d: Displacement): string {
  return d.bankDate < d.ledgerDate ? d.bankDate : d.ledgerDate;
}
