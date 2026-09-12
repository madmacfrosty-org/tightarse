/**
 * Categories as entities.
 *
 * A category's **label is not its identity**. Today it is, which means renaming
 * one is a data migration across every stored row, and it makes "Groceries" in
 * our taxonomy indistinguishable from a provider's value that happens to read
 * the same. An id fixes both. See docs/design/categorisation.md.
 *
 * Categories are never deleted. Merging is a relationship, not a deletion, so no
 * taxonomy change ever requires reprocessing: old rows keep pointing at the old
 * id and resolution follows the link.
 */

import { z } from "zod";

/**
 * What a category does to the household's money.
 *
 * **Superseded by `nature`, and kept because rows carry it.** This was
 * documented as the only thing code may branch on, and for as long as it said so
 * nothing branched on it — see #109. `nature` is what it was reaching for:
 * `movement` was two things at once, money into your own savings and money owed
 * on a loan, which differ in sign and are both balance-sheet rather than flow.
 *
 * Still written by the picker and still stored, so it is still read. `natureOf`
 * is the one place that turns it into the thing totals actually use.
 */
export const CategoryKind = z.enum(["spending", "income", "movement"]);
export type CategoryKind = z.infer<typeof CategoryKind>;

/**
 * What this book is, where the household has said.
 *
 * Optional because every row predates it. Absent does not mean "expense": it
 * means nobody has said, and `natureOf` falls back to what `kind` implies rather
 * than guessing. Nothing is excluded from a total on a guess.
 */
export const CategoryNature = z.enum([
  "asset",
  "liability",
  "income",
  "expense",
]);
export type CategoryNature = z.infer<typeof CategoryNature>;

/** Whose taxonomy a category belongs to. A provider's is not ours. */
export const Taxonomy = z.enum(["household", "provider"]);
export type Taxonomy = z.infer<typeof Taxonomy>;

/** A category's identity. Stable; everything references this rather than a label. */
export type CategoryId = string;

export const Category = z.object({
  /** Stable. Everything references this. */
  id: z.string().min(1),
  /** Presentation. Freely changeable, including to match a provider's wording. */
  label: z.string().min(1),
  /**
   * Presentation, and owned by the category rather than assigned by rank.
   *
   * Left unset by the seed so nothing visible changes on migration: the web app
   * still colours by rank until a colour is chosen deliberately.
   */
  colour: z.string().optional(),
  description: z.string().optional(),
  kind: CategoryKind,
  /** See `natureOf`. Absent on every row written before #108 step 3. */
  nature: CategoryNature.optional(),
  taxonomy: Taxonomy.default("household"),
  /** Stops new rules choosing it. Existing categorisations still resolve. */
  retired: z.boolean().default(false),
  /**
   * This category has been merged into another, which is what retirement means
   * in practice. Resolution follows it.
   */
  mergedInto: z.string().optional(),
  /**
   * A provider's category is asserted to mean one of ours. The equivalence is
   * ours to own and explain — nothing pretends the provider produced a
   * household category.
   */
  mapsTo: z.string().optional(),
});
export type Category = z.infer<typeof Category>;

/** Categories by id. */
export type CategoryCatalogue = ReadonlyMap<CategoryId, Category>;

export function catalogueOf(
  categories: readonly Category[],
): CategoryCatalogue {
  return new Map(categories.map((c) => [c.id, c]));
}

/**
 * How far a chain of relationships may be followed.
 *
 * Chains are short in practice — a retired category merged into a live one, or a
 * provider value mapped to ours. A limit rather than trust: this resolves on
 * every read, and an unbounded walk over data anyone can edit is a hang.
 */
export const MAX_RESOLUTION_DEPTH = 8;

/** Why a resolution stopped before reaching a terminal category. */
export type ResolutionStop = "cycle" | "depth" | "missing";

export interface CategoryResolution {
  /**
   * Where the reference resolves to.
   *
   * Undefined only when the id asked for is not in the catalogue at all. A chain
   * that breaks part way still resolves — to the last category actually found —
   * because a broken link is not a reason to lose the answer entirely.
   */
  readonly category: Category | undefined;
  /** The chain walked, starting with the id asked for. */
  readonly path: readonly CategoryId[];
  /** Present when the walk stopped early. Worth surfacing; not worth throwing over. */
  readonly stopped?: ResolutionStop;
}

/**
 * Follow `mergedInto` and `mapsTo` to the category a reference means now.
 *
 * Resolved at read rather than rewritten into rows, which is what lets a
 * taxonomy change avoid reprocessing entirely.
 */
export function resolveCategory(
  id: CategoryId,
  catalogue: CategoryCatalogue,
): CategoryResolution {
  const path: CategoryId[] = [id];
  const seen = new Set<CategoryId>([id]);
  let current = catalogue.get(id);

  if (!current) return { category: undefined, path, stopped: "missing" };

  for (;;) {
    const next = current.mergedInto ?? current.mapsTo;
    if (next === undefined) return { category: current, path };

    if (seen.has(next)) {
      // Two categories merged into each other, which is a data defect rather
      // than a state to resolve. Report where the walk stopped instead of
      // looping, and let the caller show it.
      return { category: current, path: [...path, next], stopped: "cycle" };
    }
    if (path.length >= MAX_RESOLUTION_DEPTH) {
      return { category: current, path, stopped: "depth" };
    }

    const target = catalogue.get(next);
    if (!target) {
      // The link names a category nobody has. The last one we did find is still
      // a better answer than nothing.
      return { category: current, path: [...path, next], stopped: "missing" };
    }

    path.push(next);
    seen.add(next);
    current = target;
  }
}

/** The kind a reference resolves to, for code that may only branch on kind. */
export function kindOf(
  id: CategoryId,
  catalogue: CategoryCatalogue,
): CategoryKind | undefined {
  return resolveCategory(id, catalogue).category?.kind;
}

/**
 * What a category is, for the purpose of totals.
 *
 * The one place `kind` turns into something code branches on — #109's
 * complaint was that no such place existed, so the field said totals depended
 * on it while nothing read it.
 *
 * Stated where the household has stated it, inferred from `kind` otherwise.
 * The inference is not a guess: `movement` is what the picker offers for money
 * that goes somewhere the household still owns, and `asset` is that same claim
 * with a sign attached. What the inference cannot produce is `liability` —
 * `kind` has no way to say "a loan" — which is exactly why `nature` exists as
 * its own field rather than as a rename.
 */
export function natureOf(category: {
  kind: CategoryKind;
  nature?: CategoryNature | undefined;
}): CategoryNature {
  if (category.nature !== undefined) return category.nature;
  if (category.kind === "income") return "income";
  if (category.kind === "movement") return "asset";
  return "expense";
}

/** The `kind` a nature implies, for as long as rows still carry one. */
export function kindFor(nature: CategoryNature): CategoryKind {
  if (nature === "income") return "income";
  if (nature === "expense") return "spending";
  return "movement";
}
