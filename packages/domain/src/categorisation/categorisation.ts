/**
 * Applying a category to a transaction.
 *
 * Carries the rule set and version that produced it, which is what makes the
 * history of a transaction's categorisation readable — including TrueLayer's own,
 * where the set is the provider and the version is a date.
 */

import { z } from "zod";

export const Categorisation = z.object({
  dedupKey: z.string().min(1),
  timestamp: z.string(),
  category: z.string().min(1),
  /** Which set produced it, and at which version. Always present. */
  setId: z.string().min(1),
  setVersion: z.number().int().nonnegative(),
  /**
   * No `rules` list. `setId` and `setVersion` are here, a rule set version is
   * immutable, and a transaction is content-addressed — so which rules
   * contributed is one fold away, for the one row anybody ever asks about.
   * Storing them denormalised a read that was never expensive.
   */
  version: z.number().int().positive(),
  /**
   * Where this version stands.
   *
   * `effective` applies. `proposed` does not and must not change what anything
   * reads — an approval flow needs a shape, and until a decision exists an
   * older effective version still holds.
   *
   * `retracted` is the opposite kind of absence, and the distinction is the
   * whole point of having two. It means a rule produced this answer and no rule
   * produces it any more: the household deleted the rule, and the category it
   * wrote has to stop counting. A proposed row is ignored and the previous
   * answer stands; a retracted row IS the latest answer, and the answer is
   * "nothing".
   *
   * Written rather than deleted so the history survives. #199 showed what
   * silence costs: a figure nobody can explain is worse than a figure that says
   * it has been withdrawn.
   *
   * `superseded` is declared and used nowhere. Left alone here rather than
   * removed in a change about money being miscategorised.
   */
  status: z.enum(["effective", "proposed", "retracted", "superseded"]),
  appliedAt: z.string(),
  appliedBy: z.string().optional(),
});
export type Categorisation = z.infer<typeof Categorisation>;

/**
 * Whether a version has been decided, so it can mask an earlier one.
 *
 * `proposed` has not been. It is excluded before versions are compared, which
 * is what lets an older effective answer go on applying while a proposal waits.
 */
export function decided(c: Categorisation): boolean {
  return c.status !== "proposed";
}

/**
 * Whether the latest decided version means a category actually applies.
 *
 * Checked AFTER picking the latest, never before. Filtering retracted rows out
 * first would let the effective version they retract win again, which is the
 * one thing a retraction exists to prevent.
 */
export function inForce(c: Categorisation): boolean {
  return c.status === "effective";
}
