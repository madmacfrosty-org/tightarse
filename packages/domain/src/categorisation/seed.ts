/**
 * The existing labels, as entities.
 *
 * The migration's first step: every category in service today becomes an entity
 * with a stable id, and the label stays byte-identical so nothing visible
 * changes. Ids are readable slugs rather than opaque, because they appear in
 * rules, in stored rows and in any diff a human reads — `groceries` is
 * reviewable in a way a UUID is not.
 *
 * Renaming a label after this is a one-field edit rather than a rewrite of every
 * stored row, which is the whole point.
 */

import { CATEGORIES, type CategoryLabel } from "./taxonomy.js";
import type { Category, CategoryKind } from "./category.js";

/**
 * `Eating Out` -> `eating-out`, `Gifts & Charity` -> `gifts-charity`.
 *
 * `&` becomes a space rather than nothing, so `R&D` reads `r-d` and not `rd` —
 * an ampersand joins two words and dropping it silently welds them together.
 *
 * The trim removes a single dash at each end, because the run collapse above has
 * already reduced any sequence to one.
 */
export function slugFor(label: string): string {
  return label
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Kinds, assigned conservatively.
 *
 * Only `Income` and `Transfer` are anything other than spending, because those
 * two are unarguable. Two others are genuinely debatable and are left as
 * spending deliberately, since that is what the totals do today and changing a
 * kind changes what the household is told it spent:
 *
 *   Savings & Investments  money to your own savings account is a movement;
 *                          money into an external investment is not, and the
 *                          ledger cannot tell which from the transaction alone.
 *   Cash Withdrawal        the money has left the account but has not been
 *                          spent yet, and nothing here ever learns what it went
 *                          on.
 *
 * Both want deciding on purpose rather than by whoever writes the next line of
 * this file.
 */
const KINDS: Partial<Record<CategoryLabel, CategoryKind>> = {
  Income: "income",
  Transfer: "movement",
};

export const SEED_CATEGORIES: readonly Category[] = CATEGORIES.map((label) => ({
  id: slugFor(label),
  label,
  kind: KINDS[label] ?? "spending",
  taxonomy: "household" as const,
  retired: false,
}));
