/**
 * How much history to ask for on one sync.
 *
 * This is ingest's policy, not the provider's. `@tightarse/truelayer` publishes
 * the limits — how far back the API will go, how long the exemption lasts, what
 * unattended access is allowed — and this decides what to request within them.
 *
 * Here rather than in the provider package because `services/ingest` is the only
 * thing that has ever used it. It sat next to the TrueLayer client on the
 * assumption that anything about fetch windows belonged with the provider, which
 * put a decision about overlap in a package named after a vendor; the overlap has
 * nothing to do with TrueLayer and everything to do with when transactions
 * actually arrive.
 */

import {
  DEEP_HISTORY_WINDOW_MINUTES,
  MAX_HISTORY_MONTHS,
  UNATTENDED_HISTORY_DAYS,
  historyFrom,
} from "@tightarse/truelayer";

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
  now = new Date(),
): SyncWindow {
  const to = now.toISOString().slice(0, 10);
  const age = now.getTime() - Date.parse(connection.connectedAt);

  if (age <= DEEP_HISTORY_WINDOW_MINUTES * 60_000) {
    return { from: historyFrom(MAX_HISTORY_MONTHS, now), to, deepHistory: true };
  }

  const gapDays = connection.lastSyncedAt
    ? (now.getTime() - Date.parse(connection.lastSyncedAt)) / DAY_MS + SYNC_OVERLAP_DAYS
    : UNATTENDED_HISTORY_DAYS;

  const days = Math.min(UNATTENDED_HISTORY_DAYS, Math.max(MIN_SYNC_DAYS, Math.ceil(gapDays)));
  return { from: new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10), to, deepHistory: false };
}
