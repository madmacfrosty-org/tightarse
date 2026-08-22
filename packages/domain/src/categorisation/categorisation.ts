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
  status: z.enum(["effective", "proposed", "superseded"]),
  appliedAt: z.string(),
  appliedBy: z.string().optional(),
});
export type Categorisation = z.infer<typeof Categorisation>;
