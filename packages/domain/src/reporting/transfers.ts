import type { RecordedTransaction } from "../ledger/transaction.js";

/**
 * Internal transfer detection.
 *
 * Money moved between the household's own accounts is not spending, but in a
 * single aggregated ledger it appears as a debit in one account and a credit in
 * another — counted as both spend and income. Against the real ledger that
 * inflated five-year totals to £1.67m in and £1.72m out, so this is a
 * correctness requirement for the primary view rather than a refinement.
 *
 * Computed at query time rather than stored. The rule needs tuning against real
 * data, and query-time means changing it shows an effect immediately instead of
 * requiring a reprocess — and it keeps the ledger deterministic, since nothing
 * here writes.
 *
 * **Deliberately conservative.** A false positive silently erases real spending
 * from the totals; a missed transfer merely leaves them inflated, which is
 * visible. Where the two trade off, this errs towards missing.
 */

export interface TransferPair {
  /** dedupKey of the outgoing leg. */
  out: string;
  /** dedupKey of the incoming leg. */
  in: string;
  /** Absolute value in minor units. */
  amount: number;
  daysApart: number;
  fromAccount: string;
  toAccount: string;
}

export interface TransferDetection {
  pairs: TransferPair[];
  /** Every dedupKey belonging to either leg of a detected transfer. */
  keys: Set<string>;
  /** Total absolute value moved internally, in minor units. */
  totalMoved: number;
}

export interface TransferOptions {
  /**
   * How far apart the two legs may be. Faster Payments is usually same-day, but
   * standing orders and inter-bank movement can lag. Beyond a few days the
   * chance of coincidence outgrows the chance of a genuine pair.
   *
   * **Measured against the real ledger, 2026-09-12**, because "a few days" was
   * a guess and widening it looked like an easy win:
   *
   *   window   pairs        window   pairs
   *       1d     240            14d     284
   *       2d     270            21d     288
   *       3d     277            30d     293
   *       5d     277            60d     308
   *       7d     281            90d     323
   *
   * Two things in that. The count is **flat from 3d to 5d** — the genuine
   * population is already captured. And from 30d out, where no real transfer
   * can plausibly sit, pairs accrue at a steady **0.50 per day**, which is the
   * coincidence rate: two unrelated amounts that happen to match, on two
   * accounts holding thousands of rows.
   *
   * Apply that rate backwards and the 16 extra pairs between 3d and 30d are
   * roughly what chance alone predicts over 27 days. Their amounts say the same
   * — £6, £13, £30, £40 between the same two accounts. Widening the window buys
   * noise, and every false pair silently erases real spending.
   *
   * So three days is not a placeholder. It is where the curve flattens.
   */
  windowDays?: number;
}

const DAY_MS = 86_400_000;

export function detectTransfers(
  rows: readonly RecordedTransaction[],
  opts: TransferOptions = {},
): TransferDetection {
  const windowDays = opts.windowDays ?? 3;

  // Group by absolute amount: a transfer's two legs are equal and opposite, so
  // only rows sharing a magnitude can ever pair.
  // Three guards below survive mutation testing and are meant to: each is a
  // fast path rather than behaviour. Dropping the zero check leaves zeroes in
  // their own bucket, where they match neither the debit nor the credit filter
  // and are skipped two lines later; dropping the length checks reaches loops
  // that produce no candidates. They are kept because they say what the code
  // means and cost nothing over nine thousand rows — not because removing them
  // would change an answer.
  const byAmount = new Map<number, RecordedTransaction[]>();
  for (const r of rows) {
    if (r.amount === 0) continue;
    const key = Math.abs(r.amount);
    const bucket = byAmount.get(key);
    if (bucket) bucket.push(r);
    else byAmount.set(key, [r]);
  }

  const pairs: TransferPair[] = [];
  const used = new Set<string>();

  for (const bucket of byAmount.values()) {
    if (bucket.length < 2) continue;

    const debits = bucket.filter((r) => r.amount < 0);
    const credits = bucket.filter((r) => r.amount > 0);
    if (debits.length === 0 || credits.length === 0) continue;

    // Candidate pairs, closest in time first. Matching nearest-first matters
    // when the same amount moves repeatedly — a monthly £500 standing order
    // would otherwise pair January's debit with June's credit.
    const candidates: Array<{
      d: RecordedTransaction;
      c: RecordedTransaction;
      days: number;
    }> = [];
    for (const d of debits) {
      for (const c of credits) {
        // Same account cannot be an internal transfer; it is a correction or a
        // reversal, which is a different thing entirely.
        if (d.accountId === c.accountId) continue;
        const days =
          Math.abs(Date.parse(d.timestamp) - Date.parse(c.timestamp)) / DAY_MS;
        if (days <= windowDays) candidates.push({ d, c, days });
      }
    }
    candidates.sort((a, b) => a.days - b.days);

    for (const { d, c, days } of candidates) {
      // Each leg belongs to at most one transfer.
      if (used.has(d.dedupKey) || used.has(c.dedupKey)) continue;
      used.add(d.dedupKey);
      used.add(c.dedupKey);
      pairs.push({
        out: d.dedupKey,
        in: c.dedupKey,
        amount: Math.abs(d.amount),
        daysApart: Math.round(days),
        fromAccount: d.accountId,
        toAccount: c.accountId,
      });
    }
  }

  return {
    pairs,
    keys: used,
    totalMoved: pairs.reduce((sum, p) => sum + p.amount, 0),
  };
}
