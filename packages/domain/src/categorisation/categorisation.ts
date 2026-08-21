/**
 * Applying a category to a transaction.
 *
 * Carries the rule set and version that produced it, which is what makes the
 * history of a transaction's categorisation readable — including TrueLayer's own,
 * where the set is the provider and the version is a date.
 */

import { z } from "zod";
import { TenantId } from "../household/member.js";

export const Categorisation = z.object({
  dedupKey: z.string().min(1),
  timestamp: z.string(),
  category: z.string().min(1),
  /** Which set produced it, and at which version. Always present. */
  setId: z.string().min(1),
  setVersion: z.number().int().nonnegative(),
  /**
   * The rules that contributed, by content hash and in fold order. Empty where
   * the categoriser cannot expose one — the provider's own classification has no
   * rule we can name.
   */
  rules: z.array(z.string()).default([]),
  version: z.number().int().positive(),
  status: z.enum(["effective", "proposed", "superseded"]),
  tags: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).optional(),
  appliedAt: z.string(),
  appliedBy: z.string().optional(),
});
export type Categorisation = z.infer<typeof Categorisation>;
