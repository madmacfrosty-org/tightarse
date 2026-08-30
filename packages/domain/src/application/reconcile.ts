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

import { reconcileAccount } from "../ledger/reconciliation.js";
import type { AccountId } from "../ledger/account.js";
import type {
  AccountReconciliation,
  Reconciliation,
  ReconciliationReport,
} from "../ports/inbound/index.js";
import type {
  ReconciliationData,
  ReconciliationMarks,
} from "../ports/outbound/index.js";

export interface ReconcileDeps {
  /** The accounts to check and the two series behind each one. */
  readonly data: ReconciliationData;
  /** Where a verdict is recorded. */
  readonly marks: ReconciliationMarks;
}

export async function reconcile(
  deps: ReconcileDeps,
  tenantId: string,
): Promise<ReconciliationReport> {
  const ids = await deps.data.accounts();
  const accounts: Record<AccountId, AccountReconciliation> = {};
  let checked = 0;
  let breaks = 0;

  for (const accountId of ids) {
    const [readings, movements] = await Promise.all([
      deps.data.readings(accountId),
      deps.data.movements(accountId),
    ]);
    const result = reconcileAccount(accountId, readings, movements);

    // Keyed on both halves, because that is what identifies the row.
    const broken = new Map(
      result.breaks.map((b) => [`${b.asOf}#${b.fetchedAt}`, b.discrepancy]),
    );
    for (const r of readings) {
      const discrepancy = broken.get(`${r.asOf}#${r.fetchedAt}`);
      if (discrepancy !== undefined) {
        await deps.marks.markBalanceReadingDirty(
          tenantId,
          accountId,
          r.asOf,
          r.fetchedAt,
          discrepancy,
        );
      } else {
        // Cleared unconditionally rather than only where a mark exists: this
        // must be able to undo itself when a late transaction explains an
        // earlier break, and it does not track what it marked last time.
        await deps.marks.clearBalanceReadingDirty(
          tenantId,
          accountId,
          r.asOf,
          r.fetchedAt,
        );
      }
    }

    accounts[accountId] = {
      readings: readings.length,
      checked: result.checked,
      breaks: result.breaks.length,
    };
    checked += result.checked;
    breaks += result.breaks.length;
  }

  return { accounts, checked, breaks };
}

/** The use case behind its inbound port, for a driver to call. */
export function reconciliation(deps: ReconcileDeps): Reconciliation {
  return { run: (tenantId) => reconcile(deps, tenantId) };
}
