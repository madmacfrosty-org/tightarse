/**
 * Which category a report should show.
 *
 * The bridge between the two mechanisms. Categorisation rows are the model the
 * ledger is moving to; enrichment rows are what it has. A transaction with both
 * takes the categorisation, because that is the one with provenance — it names
 * the set and version that produced it, and can be re-derived.
 *
 * Deliberately additive. Removing the enrichment path in the same change as
 * switching the writer would mean a window where the dashboard has nothing to
 * show, and "the categories vanished" is not a migration anyone should have to
 * live through.
 */

import { resolve, type SetOrder } from "../categorisation/resolve.js";
import { Categorisation } from "../categorisation/categorisation.js";
import type { EnrichmentRow, LedgerRow } from "./summary.js";
import type { Row } from "../ports/outbound/index.js";

/** Set precedence, from the sets themselves. Data, never load order. */
export function orderOf(sets: readonly Row[]): SetOrder[] {
  return sets
    .filter((s) => typeof s["setId"] === "string" && typeof s["order"] === "number")
    .map((s) => ({ setId: String(s["setId"]), order: Number(s["order"]) }));
}

/**
 * One category per transaction, preferring a categorisation over an enrichment.
 *
 * The provider's own is left out on purpose. It is derived from the transaction
 * rather than stored, and the reporting path already falls back to it — marking
 * it provisional, which is the honest reading of a payment rail that is not a
 * spending category.
 */
export function effectiveCategories(
  transactions: readonly LedgerRow[],
  categorisations: readonly Row[],
  enrichments: readonly EnrichmentRow[],
  order: readonly SetOrder[],
): EnrichmentRow[] {
  const stored = new Map<string, Categorisation[]>();
  for (const row of categorisations) {
    const parsed = Categorisation.safeParse(row);
    if (!parsed.success) continue;
    const forKey = stored.get(parsed.data.dedupKey) ?? [];
    forKey.push(parsed.data);
    stored.set(parsed.data.dedupKey, forKey);
  }

  const out = new Map(enrichments.map((e) => [e.dedupKey, e]));

  for (const tx of transactions) {
    const forTx = stored.get(tx.dedupKey);
    if (forTx === undefined) continue;

    const effective = resolve(tx as never, forTx, order).effective;
    // Skip the provider's own: it is not stored, so it cannot be here, but a
    // future source might be — and a report should not silently promote a
    // payment rail to a spending category.
    if (effective === undefined || effective.setId === "provider") continue;

    out.set(tx.dedupKey, { dedupKey: tx.dedupKey, category: effective.category });
  }

  return [...out.values()];
}
