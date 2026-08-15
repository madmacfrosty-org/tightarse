/**
 * Check the ledger's transactions against the balances the bank reported.
 *
 *   balance(later reading) - balance(earlier reading) == sum of amounts between
 *
 * That is the whole idea, and it needs no running balance on the transactions,
 * which is what makes it the only check covering cards — they carry none at all
 * (0 of 278 in this ledger, against 9,498 of 9,498 for accounts).
 *
 * A break means a transaction is missing, or one is there that should not be.
 * Either way every balance derived before that point is wrong, and nothing
 * detected it until now.
 *
 * ## Over the whole span, not consecutive pairs
 *
 * The first version compared each reading with the one before it, assuming a
 * reading taken on day D included every transaction dated D. Run against five
 * years of real data it reported 6 breaks in 20 checks, and one account broke
 * on every single window — which is the shape of a systematic error, not of
 * missing money.
 *
 * It was. A transaction's date is not when it settled: one dated the 12th can
 * appear in the balance on the 14th. That moves transactions between adjacent
 * windows without moving them out of the total, so consecutive pairs disagree
 * while the span is exact. Checked: all five accounts reconciled to the penny
 * over their full series, with zero breaks.
 *
 * Shifting the window by a day was tried too and did not fix it (6 breaks
 * became 4), because settlement lag is not a constant.
 *
 * So the check is the whole span: oldest reading to newest, against every
 * transaction dated between them. That is robust to redistribution and still
 * catches the thing it exists for — a transaction that is genuinely absent
 * changes the total, and no amount of lag puts it back.
 *
 * The cost is localisation: a break says something is wrong across the series
 * rather than naming the day. That is the honest trade, because the per-day
 * answer was wrong.
 *
 * ## What a break does NOT do
 *
 * It does not invent a correcting transaction. A synthetic row that makes the
 * arithmetic come out right is a healthy-looking number over missing data, and
 * it would have to be excluded from income and spend while counting toward
 * balances — a split every consumer would have to respect for ever. The reading
 * is marked dirty instead, and anything derived from it is dirty too.
 */

/** A stored balance reading, as much of it as this needs. */
export interface Reading {
  readonly accountId: string;
  /**
   * When the balance was true: the provider's own timestamp where it gave one,
   * ours otherwise. Everything here orders and windows on this rather than on
   * `fetchedAt`, because a card balance can be served from data refreshed up to
   * half an hour before we asked — measured, not assumed.
   */
  readonly asOf: string;
  /** When we asked. Carried so a break can be written back to its own row. */
  readonly fetchedAt: string;
  readonly balance: number;
}

/** A stored transaction, as much of it as this needs. */
export interface Movement {
  readonly timestamp: string;
  readonly amount: number;
}

export interface Break {
  readonly accountId: string;
  /** The newest reading — the one marked, and the end of the span. */
  readonly asOf: string;
  /** That reading's fetch time, which the row is keyed on alongside `asOf`. */
  readonly fetchedAt: string;
  /** The oldest reading, and the start of the span. */
  readonly previousAsOf: string;
  /** What the balance moved by, according to the bank. */
  readonly reported: number;
  /** What our transactions say it should have moved by. */
  readonly observed: number;
  /** reported - observed, in minor units. Positive means the bank counted more. */
  readonly discrepancy: number;
  /** How many transactions fell in the window. */
  readonly movements: number;
}

export interface ReconciliationResult {
  /** 1 when the account had enough readings to check, 0 otherwise. */
  readonly checked: number;
  readonly breaks: readonly Break[];
}

/** The day a timestamp falls on, which is the finest granularity we have. */
const dayOf = (timestamp: string): string => timestamp.slice(0, 10);

/**
 * Reconcile one account's readings against its transactions.
 *
 * Readings need not arrive sorted; they are ordered here so a caller cannot
 * produce a wrong answer by passing them in the order a scan happened to
 * return.
 *
 * A single reading is not a failure — it is the normal state of a newly
 * connected account, and of every account until a second sync has run. There is
 * simply nothing to check yet.
 */
export function reconcileAccount(
  accountId: string,
  readings: readonly Reading[],
  movements: readonly Movement[],
): ReconciliationResult {
  const ordered = [...readings].sort((a, b) => a.asOf.localeCompare(b.asOf));
  const oldest = ordered[0];
  const newest = ordered[ordered.length - 1];

  // Fewer than two readings is the normal state of a newly connected account,
  // and of every account until a second sync has run. Nothing to check is not a
  // failure.
  if (!oldest || !newest || oldest === newest) return { checked: 0, breaks: [] };

  // Both on one day cannot be checked: the transactions between them are a
  // subset of that day's and nothing says which. A limit of the data rather
  // than a discrepancy.
  if (dayOf(oldest.asOf) === dayOf(newest.asOf)) return { checked: 0, breaks: [] };

  const window = movements.filter(
    (m) => dayOf(m.timestamp) > dayOf(oldest.asOf) && dayOf(m.timestamp) <= dayOf(newest.asOf),
  );

  const reported = newest.balance - oldest.balance;
  const observed = window.reduce((total, m) => total + m.amount, 0);

  if (reported === observed) return { checked: 1, breaks: [] };

  return {
    checked: 1,
    breaks: [
      {
        accountId,
        asOf: newest.asOf,
        fetchedAt: newest.fetchedAt,
        previousAsOf: oldest.asOf,
        reported,
        observed,
        discrepancy: reported - observed,
        movements: window.length,
      },
    ],
  };
}

/** Counts to emit, split by card because cards cannot be compared to accounts. */
export function reconciliationMetrics(
  results: ReadonlyArray<{ result: ReconciliationResult; isCard: boolean }>,
): Record<string, number> {
  const sum = (predicate: (r: { isCard: boolean }) => boolean, pick: (r: ReconciliationResult) => number) =>
    results.filter(predicate).reduce((total, r) => total + pick(r.result), 0);

  return {
    // Split because a single total would say something is wrong without saying
    // where, and because an alarm that cannot tell a card from an account is
    // how the permanently-firing alarm in 927c593 happened.
    ReconciliationBreaksAccount: sum((r) => !r.isCard, (x) => x.breaks.length),
    ReconciliationBreaksCard: sum((r) => r.isCard, (x) => x.breaks.length),
    // Emitted so zero checks is distinguishable from zero breaks. An account
    // with one reading has nothing to check yet, and that must not read as
    // healthy.
    ReconciliationsChecked: sum(() => true, (x) => x.checked),
  };
}
