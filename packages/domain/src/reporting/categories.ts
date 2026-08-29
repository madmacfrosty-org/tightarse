/**
 * Which category a report should show.
 *
 * Categorisations only. The enrichment rows the old mechanism wrote are no
 * longer read: they are answers no current rule produces and nothing can
 * explain, and the design is explicit that where nothing matches any more it
 * should surface as needing attention rather than silently keeping a category
 * nobody can account for.
 *
 * The fallback existed while the two overlapped. It went once a real
 * application run covered the ledger: 6,586 of 6,616 enriched transactions are
 * categorised, and the 30 that are not are the four rule conflicts, where a set
 * claiming two answers produces none. Those now read as uncategorised, which is
 * what they are.
 */

import { resolve, type SetOrder } from "../categorisation/resolve.js";
import { Categorisation } from "../categorisation/categorisation.js";
import type { RecordedTransaction } from "../ledger/transaction.js";
import type { Row } from "../ports/outbound/index.js";

/** Set precedence, from the sets themselves. Data, never load order. */
export function orderOf(sets: readonly Row[]): SetOrder[] {
  return sets
    .filter(
      (s) => typeof s["setId"] === "string" && typeof s["order"] === "number",
    )
    .map((s) => ({ setId: String(s["setId"]), order: Number(s["order"]) }));
}

/**
 * One category per transaction, from whichever rule set outranks the rest.
 *
 * The provider's own is left out on purpose. It is derived from the transaction
 * rather than stored, and the reporting path already falls back to it — marking
 * it provisional, which is the honest reading of a payment rail that is not a
 * spending category.
 */
export function effectiveCategories(
  transactions: readonly RecordedTransaction[],
  categorisations: readonly Row[],
  order: readonly SetOrder[],
): Categorisation[] {
  const stored = new Map<string, Categorisation[]>();
  for (const row of categorisations) {
    const parsed = Categorisation.safeParse(row);
    if (!parsed.success) continue;
    const forKey = stored.get(parsed.data.dedupKey) ?? [];
    forKey.push(parsed.data);
    stored.set(parsed.data.dedupKey, forKey);
  }

  const out = new Map<string, Categorisation>();

  for (const tx of transactions) {
    const forTx = stored.get(tx.dedupKey);
    if (forTx === undefined) continue;

    const effective = resolve(tx, forTx, order).effective;
    // Skip the provider's own: it is not stored, so it cannot be here, but a
    // future source might be — and a report should not silently promote a
    // payment rail to a spending category.
    if (effective === undefined || effective.setId === "provider") continue;

    out.set(tx.dedupKey, effective);
  }

  return [...out.values()];
}
