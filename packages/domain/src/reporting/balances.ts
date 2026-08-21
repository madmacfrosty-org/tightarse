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
export function accountSeries(
  account: AccountFacts,
  movements: readonly Movement[],
  days: readonly string[],
): Array<number | undefined> {
  // Ascending, mirroring the ledger's own sort key. The dedup tiebreak is not
  // decoration: within an account every timestamp is midnight, so without it
  // the order is whatever the rows arrived in and the same request can produce
  // two different charts.
  // localeCompare rather than nested ternaries: the equal case cannot happen —
  // two rows with the same dedup key are the same row — so a branch for it
  // would be untestable except by constructing a state the ledger cannot hold.
  const rows = [...movements].sort((a, b) =>
    a.timestamp === b.timestamp ? a.dedupKey.localeCompare(b.dedupKey) : a.timestamp < b.timestamp ? -1 : 1,
  );
  if (rows.length === 0) return days.map(() => undefined);

  const firstDay = rows[0]!.timestamp.slice(0, 10);

  if (account.isCard === true) {
    // Backwards from today. The balance at the end of day D is what is owed now
    // less everything that has happened since D — which is why a missing
    // transaction shows up as a wrong shape rather than a missing point, and
    // why reconciliation matters more here than on a current account.
    const now = account.currentBalance;
    if (now === undefined) return days.map(() => undefined);
    return days.map((day) => {
      if (day < firstDay) return undefined;
      const after = rows.filter((r) => r.timestamp.slice(0, 10) > day);
      return now + after.reduce((s, r) => s + r.amount, 0);
    });
  }

  // Current account: the last figure the provider stated on or before the day.
  //
  // Two kinds of statement, merged into one ordered list rather than branched
  // on: every transaction's running balance, and the live balance read at the
  // last sync. Whichever is later wins, so a range ending today ends on the
  // live balance and a range ending last month does not — no special case for
  // "today", which would be wrong for every other range.
  const observations: Array<{ day: string; balance: number }> = rows
    .filter((r) => r.runningBalance !== undefined)
    .map((r) => ({ day: r.timestamp.slice(0, 10), balance: r.runningBalance! }));
  if (account.currentBalance !== undefined && account.balanceAsOf !== undefined) {
    observations.push({ day: account.balanceAsOf, balance: account.currentBalance });
  }
  // Stable sort keeps the live balance after a transaction on the same day,
  // because it was read later.
  observations.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  let carried: number | undefined;
  let i = 0;
  return days.map((day) => {
    while (i < observations.length && observations[i]!.day <= day) {
      carried = observations[i]!.balance;
      i += 1;
    }
    return day < firstDay ? undefined : carried;
  });
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
  for (const m of movements) byAccount.set(m.accountId, [...(byAccount.get(m.accountId) ?? []), m]);

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
