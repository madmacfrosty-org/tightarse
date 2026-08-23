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
 * `assert` puts a category on the table; `refine` changes one already there and
 * cannot fire without it. Two kinds, and arbitrary transforms would produce rule
 * sets nobody can reason about.
 *
 * There was a third, `tag`, for attaching an attribute without touching the
 * category. It was declared and never used: nothing consumed it, no entity held
 * one, and no case was recorded for it. A closed algebra earns its
 * expressiveness by being small, so an unused member is not free — it is
 * something to test, document and migrate on behalf of nobody. If a real need
 * appears it comes back as a feature with a case behind it, which costs almost
 * nothing precisely because the algebra is closed.
 */
export const Contribution = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("assert"), category: z.string().min(1) }),
  z.object({ kind: z.literal("refine"), category: z.string().min(1) }),
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
  /**
   * Which direction the rule may match.
   *
   * Credits are excluded by default: an employer sharing a name with a retailer
   * once filed £62,868 of salary as Shopping, and no pattern can tell a refund
   * from income.
   *
   * `credits` exists because direction sometimes decides the category outright —
   * interest is Income when received and Fees & Charges when paid, which is two
   * rules over one matcher and cannot be said without it. Migrating the shipped
   * patterns found 331 transactions that had lost their category for want of it.
   */
  appliesTo: z.enum(["debits", "credits", "all"]).default("debits"),
  note: z.string().optional(),
});
export type Rule = z.infer<typeof Rule>;

/**
 * Where a version stands.
 *
 * Every rule change is a proposal, whoever made it — a person with an editor, a
 * pass over conflicts, or a model. `effective` is the one the fold reads;
 * `proposed` is waiting on a decision; `rejected` records one that was declined,
 * which matters because otherwise the next run proposes the same thing again.
 */
export const RuleSetStatus = z.enum(["proposed", "effective", "rejected"]);
export type RuleSetStatus = z.infer<typeof RuleSetStatus>;

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
  /**
   * Defaults to effective so that everything written before proposals existed
   * reads as decided, which it was.
   */
  status: RuleSetStatus.default("effective"),
  createdAt: z.string(),
  createdBy: z.string().optional(),
  /** Why a proposal was declined. The most useful thing an optimiser can learn. */
  rejectedBecause: z.string().optional(),
});
export type RuleSet = z.infer<typeof RuleSet>;
