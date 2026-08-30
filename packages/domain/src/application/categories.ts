/**
 * Adding a category.
 *
 * The moment anyone needs one is while filing something under it, so this is a
 * small deliberate act rather than an administrative screen nobody visits.
 *
 * Created before it is used, never as part of a proposal. A proposal is checked
 * against the catalogue before anything is computed — a rule naming a category
 * that does not exist is refused — so a category invented inside one would mean
 * previewing against a catalogue that is not the one the apply will use. One
 * truth, in one order: the category exists, then rules may name it.
 */

import { Category, type CategoryKind } from "../categorisation/category.js";
import { slugFor } from "../categorisation/seed.js";
import type { Categories, Row } from "../ports/outbound/index.js";

/**
 * The name is taken.
 *
 * Named rather than a bare `Error` because it is an answer, not a fault: the
 * caller is meant to read it and pick the existing category. An adapter that
 * cannot tell it apart from a failure reports "internal error" and hides the
 * one sentence that says what to do instead.
 */
export class CategoryExists extends Error {
  constructor(
    readonly existing: { readonly id: string; readonly label: string },
  ) {
    super(`“${existing.label}” already uses the name ${existing.id}`);
    this.name = "CategoryExists";
  }
}

export interface CategoryDeps {
  readonly categories: Categories;
}

export interface NewCategory {
  readonly label: string;
  /**
   * What it does to the household's money.
   *
   * Offered rather than assumed, and defaulted to spending because that is what
   * nearly everything filed from a list of debits is. It is not everything: a
   * debit into savings is a `movement`, and filed as spending it overstates
   * every spending figure from then on — invisibly, until somebody questions
   * one. Totals branch on this and nothing else, so it is worth a control.
   */
  readonly kind?: CategoryKind | undefined;
}

/**
 * Add one, and refuse a duplicate rather than overwriting it.
 *
 * `putCategory` overwrites in place, which is right for editing a label and
 * wrong here: "Eating Out" and "eating out" both slug to `eating-out`, and
 * silently replacing the first with the second would rename a category that
 * rules and stored categorisations already name.
 */
export async function createCategory(
  deps: CategoryDeps,
  tenantId: string,
  request: NewCategory,
): Promise<Category> {
  const label = request.label.trim();
  const id = slugFor(label);
  if (id.length === 0) {
    throw new Error("A category needs a label with letters or numbers in it");
  }

  const existing = (await deps.categories.listCategories(tenantId))
    .map((r: Row) => Category.safeParse(r))
    .flatMap((p) => (p.success ? [p.data] : []));

  const clash = existing.find((c) => c.id === id);
  // Named, so the answer is "use that one" rather than "try again".
  if (clash) throw new CategoryExists(clash);

  const category: Category = {
    id,
    label,
    kind: request.kind ?? "spending",
    taxonomy: "household",
    retired: false,
  };
  await deps.categories.putCategory(tenantId, category);
  return category;
}
