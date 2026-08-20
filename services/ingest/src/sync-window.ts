/**
 * How much history to ask for on one sync.
 *
 * This is ingest's policy, not the provider's. The limits arrive as an argument —
 * how far back the API will go, how long the exemption lasts, what unattended
 * access is allowed — and this decides what to request within them. Taking them
 * rather than importing them is what keeps this function free of any particular
 * bank, and testable without one.
 *
 * Here rather than in the provider package because `services/ingest` is the only
 * thing that has ever used it. It sat next to the TrueLayer client on the
 * assumption that anything about fetch windows belonged with the provider, which
 * put a decision about overlap in a package named after a vendor; the overlap has
 * nothing to do with TrueLayer and everything to do with when transactions
 * actually arrive.
 */

import type { BankLimits } from "@tightarse/ports";

/**
 * The narrowest routine window.
 *
 * A daily sync only needs the last day, but pending rows settle over several days
 * and card transactions frequently arrive dated earlier than they appear. A window
 * that starts exactly where the last one ended loses those for ever, so the floor
 * buys about a week of overlap for nothing.
 */
export const MIN_SYNC_DAYS = 10;

/** Added to a measured gap, for the same late-arrival reason. */
export const SYNC_OVERLAP_DAYS = 3;

const DAY_MS = 86_400_000;

/**
 * The same day-of-month, `months` earlier, clamped to the end of the target month.
 *
 * `setMonth` alone turns "one month before 31 March" into 3 March, because 31
 * February rolls forward — a silent three-day gap in a fetch window, and exactly
 * the kind of date bug nobody notices until reconciliation disagrees.
 */
function monthsBefore(months: number, now: Date): string {
  const day = now.getUTCDate();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1));
  const lastDayOfTarget = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDayOfTarget));
  return d.toISOString().slice(0, 10);
}

export interface SyncWindow {
  /** Inclusive start, YYYY-MM-DD. */
  from: string;
  /** Inclusive end, YYYY-MM-DD. */
  to: string;
  /** True while the SCA exemption still allows the full history. */
  deepHistory: boolean;
}

/**
 * The date range to request for one connection.
 *
 * Inside the exemption window, everything the bank will give — this is the only
 * moment it is available and it does not come back. After that, enough to cover
 * the gap since the last SUCCESSFUL sync, plus overlap, bounded at both ends.
 *
 * `lastSyncedAt` absent means nothing has ever been fetched, so it asks for the
 * widest window allowed rather than the narrowest: a connection that has never
 * worked has the most to catch up on, not the least.
 */
export function syncWindow(
  connection: { connectedAt: string; lastSyncedAt?: string | undefined },
  limits: BankLimits,
  now = new Date(),
): SyncWindow {
  const to = now.toISOString().slice(0, 10);
  const age = now.getTime() - Date.parse(connection.connectedAt);

  if (age <= limits.exemptionMinutes * 60_000) {
    return { from: monthsBefore(limits.maxHistoryMonths, now), to, deepHistory: true };
  }

  const gapDays = connection.lastSyncedAt
    ? (now.getTime() - Date.parse(connection.lastSyncedAt)) / DAY_MS + SYNC_OVERLAP_DAYS
    : limits.unattendedHistoryDays;

  const days = Math.min(limits.unattendedHistoryDays, Math.max(MIN_SYNC_DAYS, Math.ceil(gapDays)));
  return { from: new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10), to, deepHistory: false };
}
