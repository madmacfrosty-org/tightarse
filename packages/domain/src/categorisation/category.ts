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
 * The only thing code may branch on. Labels and colours are presentation and
 * change freely; this does not, because totals depend on it.
 */
export const CategoryKind = z.enum(["spending", "income", "movement"]);
export type CategoryKind = z.infer<typeof CategoryKind>;

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
