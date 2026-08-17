/**
 * Which categorisation is in force, and what else was said.
 *
 * A transaction can carry several: one per rule set that had an opinion, plus the
 * provider's own. Each may have a history of versions. This turns that pile into
 * "the effective one" without discarding the rest, because what the other sources
 * said is the audit answer and, where they disagree, a defect signal.
 *
 * Pure. Takes rows, returns a view.
 */

import type { Categorisation } from "@tightarse/schema";
import { providerCategorisation, type ProviderInput } from "./provider.js";

/** How much a set is trusted, highest first. Data, never load order. */
export interface SetOrder {
  readonly setId: string;
  readonly order: number;
}

export interface Resolved {
  /** In force. Undefined when nothing has categorised this transaction. */
  readonly effective?: Categorisation | undefined;
  /**
   * The latest version from every set that had an opinion, most trusted first —
   * including the effective one. "What did each source say" is the audit
   * question, so nothing is discarded.
   */
  readonly bySet: readonly Categorisation[];
  /** Sets whose category differs from the effective one. */
  readonly disagreeing: readonly Categorisation[];
  /** Every version of the effective set's categorisation, oldest first. */
  readonly history: readonly Categorisation[];
}

/**
 * The newest version of each set's categorisation.
 *
 * `proposed` versions are excluded from being effective: a proposal must not
 * change what is displayed, or approving it would be decoration. They remain
 * visible in history.
 */
function latestPerSet(all: readonly Categorisation[]): Map<string, Categorisation> {
  const out = new Map<string, Categorisation>();
  for (const c of all) {
    if (c.status === "proposed") continue;
    const seen = out.get(c.setId);
    if (seen === undefined || c.version > seen.version) out.set(c.setId, c);
  }
  return out;
}

/**
 * Resolve a transaction's categorisation.
 *
 * `stored` is what the table holds for this transaction; the provider's is
 * derived from the transaction itself, so a transaction nothing has categorised
 * still resolves to something — which is the state the entire ledger is in
 * before any rule set has been applied.
 *
 * A set absent from `order` sorts last rather than being dropped. Dropping it
 * would make a categorisation invisible because somebody forgot to rank its set,
 * which is a silent failure; ranking it last is merely unhelpful.
 */
export function resolve(
  tx: ProviderInput,
  stored: readonly Categorisation[],
  order: readonly SetOrder[],
): Resolved {
  const provider = providerCategorisation(tx);
  const all = provider === undefined ? [...stored] : [...stored, provider];

  const rank = new Map(order.map((o) => [o.setId, o.order]));
  const rankOf = (setId: string): number => rank.get(setId) ?? Number.MAX_SAFE_INTEGER;

  const bySet = [...latestPerSet(all).values()].sort((a, b) => {
    const byRank = rankOf(a.setId) - rankOf(b.setId);
    // Stable within equal rank, so the result does not depend on row order.
    return byRank !== 0 ? byRank : a.setId.localeCompare(b.setId);
  });

  const effective = bySet[0];
  return {
    ...(effective !== undefined ? { effective } : {}),
    bySet,
    disagreeing: effective === undefined ? [] : bySet.filter((c) => c.category !== effective.category),
    history:
      effective === undefined
        ? []
        : all.filter((c) => c.setId === effective.setId).sort((a, b) => a.version - b.version),
  };
}
