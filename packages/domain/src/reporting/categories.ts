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
import { PROVIDER_SET } from "../categorisation/provider.js";
import type { RecordedTransaction } from "../ledger/transaction.js";
import type { Row } from "../ports/outbound/index.js";
import { orderedSets, type Adoptions } from "../categorisation/adoption.js";

/**
 * Set precedence, from what the tenant adopted.
 *
 * Falls back to the sets' own `order` when a tenant has adopted nothing, which
 * is every tenant today: precedence is mid-migration from the set to the
 * adoption (#121), and the fallback is what lets both exist without a data
 * change. It goes when every tenant has a list.
 *
 * A set that exists but was not adopted does not rank at all, which is the
 * point — a shared set sitting in the table is an offer, not an instruction.
 */
export function precedenceFor(
  adoptions: Adoptions,
  sets: readonly Row[],
): SetOrder[] {
  const shaped = sets
    .filter(
      (s) => typeof s["setId"] === "string" && typeof s["order"] === "number",
    )
    .map((s) => ({ setId: String(s["setId"]), order: Number(s["order"]) }));

  return orderedSets(adoptions, shaped).map((s, index) => ({
    setId: s.setId,
    order: index,
  }));
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
