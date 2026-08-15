/**
 * Run the reconciliation over a household's accounts, and record what it found.
 *
 * A phase rather than part of the transform, because the transform runs once per
 * raw object with no ordering between them: a balance reading and the
 * transactions it should be checked against arrive as separate S3 events, in
 * whatever order Lambda schedules them. Checking at write time would compare
 * against whatever had happened to land.
 *
 * Safe to re-run. It recomputes from the readings and transactions each time and
 * overwrites its own marks, so a break that is later explained — by a delayed
 * transaction arriving, say — clears itself rather than needing to be retracted.
 * That is also why nothing here appends a correcting row: a correction would
 * have to be retracted, and retractions accumulate.
 */

import { reconcileAccount, reconciliationMetrics, type Movement, type Reading } from "./reconcile.js";

export interface ReconcilePhaseDeps {
  /** Accounts to check, and whether each is a card. */
  readonly accounts: () => Promise<ReadonlyArray<{ accountId: string; isCard: boolean }>>;
  readonly readings: (accountId: string) => Promise<readonly Reading[]>;
  readonly movements: (accountId: string) => Promise<readonly Movement[]>;
  /** Flag a reading that did not add up, and how far off it was. */
  readonly markDirty: (accountId: string, fetchedAt: string, discrepancy: number) => Promise<void>;
  /** Clear a mark on a reading that now reconciles. */
  readonly clearDirty: (accountId: string, fetchedAt: string) => Promise<void>;
  readonly log?: ((line: string) => void) | undefined;
}

export interface ReconcilePhaseResult {
  readonly accounts: number;
  readonly checked: number;
  readonly breaks: number;
  readonly metrics: Readonly<Record<string, number>>;
}

export async function runReconciliation(deps: ReconcilePhaseDeps): Promise<ReconcilePhaseResult> {
  const write = deps.log ?? console.log;
  const accounts = await deps.accounts();
  const results: Array<{ result: ReturnType<typeof reconcileAccount>; isCard: boolean }> = [];

  for (const account of accounts) {
    const [readings, movements] = await Promise.all([
      deps.readings(account.accountId),
      deps.movements(account.accountId),
    ]);
    const result = reconcileAccount(account.accountId, readings, movements);
    results.push({ result, isCard: account.isCard });

    const broken = new Map(result.breaks.map((b) => [b.fetchedAt, b.discrepancy]));
    for (const r of readings) {
      const discrepancy = broken.get(r.fetchedAt);
      if (discrepancy !== undefined) await deps.markDirty(account.accountId, r.fetchedAt, discrepancy);
      // Cleared unconditionally rather than only where a mark exists: this
      // phase must be able to undo itself when a late transaction explains an
      // earlier break, and it does not track what it marked last time.
      else await deps.clearDirty(account.accountId, r.fetchedAt);
    }

    // Counts only. An amount here would be a balance, and a balance is as
    // personal as a transaction.
    write(
      JSON.stringify({
        accountId: account.accountId,
        isCard: account.isCard,
        readings: readings.length,
        checked: result.checked,
        breaks: result.breaks.length,
      }),
    );
  }

  const metrics = reconciliationMetrics(results);
  return {
    accounts: accounts.length,
    checked: results.reduce((n, r) => n + r.result.checked, 0),
    breaks: results.reduce((n, r) => n + r.result.breaks.length, 0),
    metrics,
  };
}
