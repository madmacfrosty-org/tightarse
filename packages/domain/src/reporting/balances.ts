/**
 * Balance over time: one point per day, for the household as a whole.
 *
 * Pure — no DynamoDB, no HTTP. Takes rows and returns a series.
 *
 * Two different derivations, because the provider gives two different things:
 *
 * - **Current accounts** carry a `runningBalance` on every transaction. That is
 *   the provider's own running total and it is authoritative, so a day's
 *   balance is simply the last one on or before that day.
 * - **Cards** carry none at all — measured at 0 of 2,287 across every card in
 *   the household, against 9,498 of 9,498 on the current accounts. Their
 *   history has to be walked backwards from the balance we hold today, taking
 *   off everything that happened since.
 *
 * Both are validated by the same arithmetic reconciliation runs, so a break
 * shows up there rather than as a quietly wrong line on a chart.
 */

/** What this needs from a transaction. Deliberately less than the ledger row. */
export interface Movement {
  readonly accountId: string;
  readonly timestamp: string;
  readonly amount: number;
  /**
   * The ledger's tiebreak within a timestamp.
   *
   * Every transaction is stamped midnight, so the timestamp orders nothing
   * within a day. The ledger's sort key is `timestamp#kind#dedup`, and this has
   * to sort the same way — otherwise "the last running balance of the day" is
   * whatever order the rows happened to arrive in, and two identical requests
   * can draw different charts.
   */
  readonly dedupKey: string;
  /** The provider's running total after this transaction. Cards never have one. */
  readonly runningBalance?: number | undefined;
  /**
   * Absent means settled.
   *
   * A derived position sums settled legs only, so that it stays comparable with
   * the provider's own chain — which is a settled-only figure. A pending row
   * carries an amount and no running balance, so counting it would make every
   * account diverge by whatever happens to be in flight, exactly where a real
   * disagreement most needs to be visible.
   */
  readonly status?: string | undefined;
}

/** Pending rows are excluded from a position; absent status means settled. */
export function isSettled(m: Movement): boolean {
  return m.status !== "pending";
}

export interface AccountFacts {
  readonly accountId: string;
  /** Absent means not yet known, which is not the same as false. See #29. */
  readonly isCard?: boolean | undefined;
  /** What the provider says the balance is now. For a card, what is owed. */
  readonly currentBalance?: number | undefined;
  /**
   * The day `currentBalance` was read, from the account's last sync.
   *
   * Present so the live balance can be treated as one more observation rather
   * than as a special case for "today". A current account's running balance is
   * only as fresh as its last settled transaction, so on a quiet couple of days
   * it lags the real balance — the household's came out £56 short, which is
   * small, explainable, and exactly the kind of mismatch against the account
   * tiles that reads as a bug.
   */
  readonly balanceAsOf?: string | undefined;
}

import type { BalancePoint } from "../ports/inbound/index.js";

const DAY = 86_400_000;

/** Every date from `from` to `to`, both ends inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += DAY) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * The balance of one account at the end of each requested day.
 *
 * `undefined` for a day before the account has any data — distinct from zero,
 * which is a real balance. The caller decides what to do with the difference,
 * and the whole point of the coverage rule is that it never has to guess.
 */
import { positionsFor, type Leg } from "../ledger/books.js";

/**
 * The ledger's own order for an account's rows.
 *
 * Ascending, mirroring the ledger's sort key. The dedup tiebreak is not
 * decoration: within an account every timestamp is midnight, so without it the
 * order is whatever the rows arrived in and the same request can produce two
 * different charts.
 *
 * localeCompare rather than nested ternaries: the equal case cannot happen —
 * two rows with the same dedup key are the same row — so a branch for it would
 * be untestable except by constructing a state the ledger cannot hold.
 */
export function inLedgerOrder(movements: readonly Movement[]): Movement[] {
  return [...movements].sort((a, b) =>
    a.timestamp === b.timestamp
      ? a.dedupKey.localeCompare(b.dedupKey)
      : a.timestamp < b.timestamp
        ? -1
        : 1,
  );
}

/**
 * The position a book that is an account held before the ledger begins.
 *
 * A derived position is the sum of a book's legs, so an account needs the
 * figure those legs start from or it reads as however much history we happen to
 * hold. Neither figure here is stored: both are recovered from what the
 * provider already told us.
 *
 * For a current account that is the first stated running balance less
 * everything up to and including the transaction carrying it — which is only
 * correct because the running balance is the position *after* its transaction.
 * That was measured against the household's own ledger rather than assumed; see
 * `checkRunningBalanceChain`.
 *
 * For a card there is no running balance at all, so the only stated figure is
 * what is owed now, walked back over every amount.
 *
 * **Both are returned in leg convention** — negative left the book, positive
 * arrived — which for a card is the negation of how `accountSeries` reports it.
 * A card's stated balance is what is *owed*, carried positive, while spending on
 * it is a negative amount; the two conventions are mirror images and today the
 * flip is buried inside `accountSeries`. Naming it here is not a fix: it is the
 * asset/liability distinction that #108 step 3 introduces as `nature`, surfaced
 * where the arithmetic first trips over it.
 */
export function openingPosition(
  account: AccountFacts,
  movements: readonly Movement[],
): number | undefined {
  const rows = inLedgerOrder(movements).filter(isSettled);
  if (rows.length === 0) return undefined;
  const total = (upTo: number): number =>
    rows.slice(0, upTo).reduce((sum, r) => sum + r.amount, 0);

  if (account.isCard === true) {
    if (account.currentBalance === undefined) return undefined;
    // Negated: `currentBalance` is what is owed, carried positive.
    return -account.currentBalance - total(rows.length);
  }

  const first = rows.findIndex((r) => r.runningBalance !== undefined);
  if (first === -1) return undefined;
  return rows[first]!.runningBalance! - total(first + 1);
}

export function accountSeries(
  account: AccountFacts,
  movements: readonly Movement[],
  days: readonly string[],
): Array<number | undefined> {
  const rows = inLedgerOrder(movements);
  if (rows.length === 0) return days.map(() => undefined);

  const opening = openingPosition(account, movements);
  if (opening === undefined) return days.map(() => undefined);

  // A book's position is the running sum of its legs — #108 step 2, one rule
  // for every book. This replaces carrying the provider's own running balance
  // forward, which was an observation rather than a derivation and which only
  // agreed with the legs while the ledger was complete and correctly dated.
  // Where the two now differ, the ledger and the bank differ; that is the
  // disagreement this is meant to show rather than a cost of showing it.
  const legs: Leg[] = rows.filter(isSettled).map((r) => ({
    book: r.accountId,
    amount: r.amount,
    appliesAt: r.timestamp,
    recordedAt: r.timestamp,
  }));
  const derived = positionsFor(legs, days, opening);

  // A card states what is OWED, carried positive, while spending on it is a
  // negative amount. The model holds one convention and the wire keeps the
  // other, so the flip happens here, once, with a name on it. #108 step 3
  // replaces this with `nature` on the book itself.
  const sign = account.isCard === true ? -1 : 1;

  // Before the account's first row there is no position to state. The opening
  // is what the legs start from, not a figure the provider ever asserted.
  const firstDay = rows[0]!.timestamp.slice(0, 10);
  return days.map((day, i) =>
    day < firstDay ? undefined : sign * derived[i]!,
  );
}

/**
 * The household's net position for each day: cash less what is owed on cards.
 *
 * An account with no value for a day contributes nothing, which is only safe
 * because the range has already been clamped to where every account has data.
 * Drawing a total that silently omits an account is the failure this whole
 * feature is arranged to avoid — see #33, and #29 for the same mistake made
 * with a missing flag rather than a missing day.
 */
export function netPositionSeries(
  accounts: readonly AccountFacts[],
  movements: readonly Movement[],
  days: readonly string[],
): BalancePoint[] {
  const byAccount = new Map<string, Movement[]>();
  for (const m of movements)
    byAccount.set(m.accountId, [...(byAccount.get(m.accountId) ?? []), m]);

  const series = accounts.map((a) => ({
    isCard: a.isCard === true,
    values: accountSeries(a, byAccount.get(a.accountId) ?? [], days),
  }));

  return days.map((date, d) => {
    let net = 0;
    for (const s of series) {
      const v = s.values[d];
      if (v === undefined) continue;
      // A card's balance is what is OWED, expressed positive by the provider.
      // Subtracted, never added: adding it is the £567.90 bug, which overstated
      // the household by twice the debt.
      net += s.isCard ? -v : v;
    }
    return { date, net };
  });
}
