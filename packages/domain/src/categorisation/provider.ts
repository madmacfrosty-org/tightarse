/**
 * The provider's own classification, as a categorisation.
 *
 * Every transaction carries one, and 100% coverage is misleading: the values are
 * payment rails rather than spending categories. Over three quarters of the real
 * ledger is the two most generic of them, which say nothing about what the money
 * was for.
 *
 * So these are categories in the PROVIDER'S taxonomy, not ours. Turning one into
 * a household category is a mapping we assert between categories, resolved
 * separately — nothing here pretends the provider produced a household category.
 *
 * Derived rather than stored. Its input is already on the immutable transaction
 * row, so it costs nothing to reproduce and would cost a row per transaction to
 * keep.
 */

import type { Categorisation } from "./categorisation.js";

/** The set id these categorisations are attributed to. */
export const PROVIDER_SET = "provider";

/**
 * What this needs from a transaction. Deliberately less than the ledger row.
 */
export interface ProviderInput {
  readonly dedupKey: string;
  readonly timestamp: string;
  /** TrueLayer's `transaction_category` — PURCHASE, DIRECT_DEBIT, ATM… */
  readonly providerCategory?: string | undefined;
  /**
   * When we fetched it. Used as the set version.
   *
   * The provider publishes no taxonomy version, so this is an OBSERVATION stamp
   * and not a version of their logic. Calling it a version would imply we could
   * detect a change in how they classify; recording what we saw and when admits
   * that we could not.
   */
  readonly ingestedAt?: string | undefined;
}

/**
 * The provider's categorisation for a transaction, or undefined where it made
 * none.
 *
 * Always version 1 and always `effective` in its own right — precedence between
 * sets decides whether it is the effective one overall, and the provider set
 * ranks last.
 */
export function providerCategorisation(
  tx: ProviderInput,
): Categorisation | undefined {
  if (tx.providerCategory === undefined || tx.providerCategory === "")
    return undefined;

  return {
    dedupKey: tx.dedupKey,
    timestamp: tx.timestamp,
    // In the provider's taxonomy. A mapping to ours is asserted elsewhere, and
    // for most of these values there is deliberately no mapping at all.
    category: tx.providerCategory,
    setId: PROVIDER_SET,
    // Dateless observations sort first, which is honest: an unstamped reading is
    // the least trustworthy one we hold.
    setVersion: observationVersion(tx.ingestedAt),
    version: 1,
    status: "effective",
    appliedAt: tx.ingestedAt ?? tx.timestamp,
  };
}

/**
 * A date turned into a monotonic integer, because a set version is a number and
 * the only thing we can honestly pin here is when we looked.
 *
 * `20260817` rather than a timestamp: day granularity is all that is meaningful
 * for a taxonomy nobody versions, and it keeps the number readable in a row.
 */
export function observationVersion(ingestedAt: string | undefined): number {
  if (ingestedAt === undefined) return 0;
  const digits = ingestedAt.slice(0, 10).replace(/-/g, "");
  const n = Number(digits);
  return Number.isFinite(n) ? n : 0;
}
