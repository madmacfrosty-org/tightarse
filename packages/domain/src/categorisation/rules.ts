/**
 * Rules as values, in versioned sets.
 *
 * A rule is data rather than code: authored, ordered, and attributable to the set
 * and version that produced a categorisation. See docs/design/categorisation.md.
 */

import { z } from "zod";

/** A predicate over a transaction, not a pattern over a string. */
export const Matcher = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("merchant"), pattern: z.string().min(1) }),
  z.object({ kind: z.literal("providerCategory"), value: z.string().min(1) }),
  z.object({ kind: z.literal("transaction"), dedupKey: z.string().min(1) }),
]);
export type Matcher = z.infer<typeof Matcher>;

/**
 * What a matching rule contributes to the fold.
 *
 * `assert` puts a category on the table, `refine` changes one already there,
 * `tag` attaches an attribute without touching the category. Three kinds is
 * enough for every case met so far; arbitrary transforms would produce rule sets
 * nobody can reason about.
 */
export const Contribution = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("assert"), category: z.string().min(1) }),
  z.object({ kind: z.literal("refine"), category: z.string().min(1) }),
  z.object({ kind: z.literal("tag"), tag: z.string().min(1) }),
]);
export type Contribution = z.infer<typeof Contribution>;

/**
 * A rule is a VALUE, not an entity. It carries no id of its own and no enabled
 * flag: editing produces a new set version containing a different value, and
 * disabling is a set version without it. Where identity is needed it is the
 * content hash, exactly as a transaction's is.
 */
export const Rule = z.object({
  matcher: Matcher,
  contributes: Contribution,
  /** Credits are excluded by default; an employer sharing a name with a
   *  retailer once filed £62,868 of salary as Shopping. */
  appliesTo: z.enum(["debits", "all"]).default("debits"),
  note: z.string().optional(),
});
export type Rule = z.infer<typeof Rule>;

export const RuleSet = z.object({
  setId: z.string().min(1),
  /** Immutable. A change produces the next version, never a mutation. */
  version: z.number().int().nonnegative(),
  name: z.string().min(1),
  /** Explicit precedence. Data, never load order — it decides whether a
   *  model-proposed rule can outrank one written by hand. */
  order: z.number().int(),
  /** True means never regenerated. Overrides live in an authored set. */
  authored: z.boolean(),
  /** Ordered: the fold applies matching rules in this order. */
  rules: z.array(Rule),
  createdAt: z.string(),
  createdBy: z.string().optional(),
});
export type RuleSet = z.infer<typeof RuleSet>;
