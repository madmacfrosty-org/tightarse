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
 * application run covered the ledger: all but a handful of enriched
 * transactions are categorised, and the remainder are rule conflicts, where a
 * set claiming two answers produces none. Those now read as uncategorised,
 * which is what they are.
 */

import { resolve, type SetOrder } from "../categorisation/resolve.js";
import { Categorisation } from "../categorisation/categorisation.js";
import { PROVIDER_SET } from "../categorisation/provider.js";
import type { RecordedTransaction } from "../ledger/transaction.js";
import type { Row } from "../ports/outbound/index.js";

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
  /**
   * The moment to answer as of. Rows recorded after it are not yet known.
   *
   * Absent means now, which is every existing caller and which reads exactly as
   * it did before: nothing has been recorded after now. Supplying a past
   * instant is #108 step 4 — "what did March say in April" — and it works by
   * discarding what we had not decided yet, not by recomputing anything.
   */
  asAt?: string,
): Categorisation[] {
  const stored = new Map<string, Categorisation[]>();
  for (const row of categorisations) {
    const parsed = Categorisation.safeParse(row);
    if (!parsed.success) continue;
    if (asAt !== undefined && parsed.data.appliedAt > asAt) continue;
    const forKey = stored.get(parsed.data.dedupKey) ?? [];
    forKey.push(parsed.data);
    stored.set(parsed.data.dedupKey, forKey);
  }

  const out = new Map<string, Categorisation>();

  for (const tx of transactions) {
    const forTx = stored.get(tx.dedupKey);
    if (forTx === undefined) continue;

    const effective = resolve(tx, forTx, order).effective;
    // Skip the synthesised fallback — the payment rail standing in for an
    // answer. A report should not silently promote one to a spending category.
    //
    // Named by its constant rather than by a literal. A seeded RULE SET was
    // once also called `provider`, and this line discarded everything it
    // asserted; the constant is what the sentinel means, and nothing else may
    // borrow it.
    if (effective === undefined || effective.setId === PROVIDER_SET) continue;

    out.set(tx.dedupKey, effective);
  }

  return [...out.values()];
}
