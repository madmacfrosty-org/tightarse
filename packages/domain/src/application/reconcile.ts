/**
 * Reconcile a household's ledger against the balances its banks reported.
 *
 * The use case, not the job: it reads through ports, decides, and records what
 * it decided. Constructing a DynamoDB client, scanning a table, emitting a
 * metric and writing a log line are all somebody else's business.
 *
 * A phase of its own rather than part of the transform, because the transform
 * runs once per raw object with no ordering between them: a balance reading and
 * the transactions it should be checked against arrive as separate S3 events,
 * in whatever order Lambda schedules them. Checking at write time would compare
 * against whatever had happened to land.
 *
 * Safe to re-run. It recomputes from the readings and transactions each time
 * and overwrites its own marks, so a break later explained — by a delayed
 * transaction arriving, say — clears itself rather than needing to be
 * retracted. That is also why nothing here appends a correcting row: a
 * correction would have to be retracted, and retractions accumulate.
 */

import {
  reconcileAccount,
  reconciliationMetrics,
  type ReconciliationResult,
} from "../ledger/reconciliation.js";
import type { Reconciliation, ReconciliationReport } from "../ports/inbound/index.js";
import type { ReconciliationData, ReconciliationMarks } from "../ports/outbound/index.js";

export interface ReconcileDeps {
  /** The accounts to check and the two series behind each one. */
  readonly data: ReconciliationData;
  /** Where a verdict is recorded. */
  readonly marks: ReconciliationMarks;
}

export async function reconcile(deps: ReconcileDeps, tenantId: string): Promise<ReconciliationReport> {
  const accounts = await deps.data.accounts();
  const results: Array<{ result: ReconciliationResult; isCard: boolean }> = [];
  const lines: string[] = [];

  for (const account of accounts) {
    const [readings, movements] = await Promise.all([
      deps.data.readings(account.accountId),
      deps.data.movements(account.accountId),
    ]);
    const result = reconcileAccount(account.accountId, readings, movements);
    results.push({ result, isCard: account.isCard });

    // Keyed on both halves, because that is what identifies the row.
    const broken = new Map(result.breaks.map((b) => [`${b.asOf}#${b.fetchedAt}`, b.discrepancy]));
    for (const r of readings) {
      const discrepancy = broken.get(`${r.asOf}#${r.fetchedAt}`);
      if (discrepancy !== undefined) {
        await deps.marks.markBalanceReadingDirty(tenantId, account.accountId, r.asOf, r.fetchedAt, discrepancy);
      } else {
        // Cleared unconditionally rather than only where a mark exists: this
        // must be able to undo itself when a late transaction explains an
        // earlier break, and it does not track what it marked last time.
        await deps.marks.clearBalanceReadingDirty(tenantId, account.accountId, r.asOf, r.fetchedAt);
      }
    }

    // Counts only. An amount here would be a balance, and a balance is as
    // personal as a transaction.
    //
    // Returned rather than written. This used to default to `console.log`, which
    // is a global reached for from inside the domain — the exact dependency this
    // package exists to not have. The caller owns where a line goes.
    lines.push(
      JSON.stringify({
        accountId: account.accountId,
        isCard: account.isCard,
        readings: readings.length,
        checked: result.checked,
        breaks: result.breaks.length,
      }),
    );
  }

  return {
    accounts: accounts.length,
    checked: results.reduce((n, r) => n + r.result.checked, 0),
    breaks: results.reduce((n, r) => n + r.result.breaks.length, 0),
    metrics: reconciliationMetrics(results),
    lines,
  };
}

/** The use case behind its inbound port, for a driver to call. */
export function reconciliation(deps: ReconcileDeps): Reconciliation {
  return { run: (tenantId) => reconcile(deps, tenantId) };
}
