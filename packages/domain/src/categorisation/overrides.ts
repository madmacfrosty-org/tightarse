/**
 * A person correcting one transaction.
 *
 * An override is a rule with a `transaction` matcher, in a set marked authored.
 * Unifying the concept buys uniform provenance — one mechanism, one history,
 * one place to ask why a transaction says what it does — and makes promotion
 * natural: generalising an override is moving the rule into a lower-precedence
 * set with its matcher widened.
 *
 * Its own set rather than sitting among the household's merchant rules, because
 * within a set two asserts colliding is a conflict, and an override asserting
 * over a merchant rule is not a conflict — it is the point. Precedence between
 * sets is how "this one, specifically" outranks "merchants like this".
 *
 * Ordered above everything, including hand-written merchant rules, because an
 * override is about ONE transaction and whoever wrote it was looking at that
 * transaction. Nothing has better information.
 */

import { evaluate, inPrecedenceOrder } from "./evaluate.js";
import type { Rule, RuleSet } from "./rules.js";
import type { Candidate } from "./taxonomy.js";
import type { CategoryId } from "./category.js";

export const OVERRIDES = "overrides";

/**
 * Above `household`, which is 0.
 *
 * Negative rather than renumbering everything below it: `order` is data that
 * stored rules reference, and shifting it is a migration for no gain.
 */
export const OVERRIDES_ORDER = -1;

/** The set an override lives in, or the shape a first one takes. */
export function overridesSet(sets: readonly RuleSet[], now: Date): RuleSet {
  const existing = sets.find((s) => s.setId === OVERRIDES);
  if (existing) return existing;
  return {
    setId: OVERRIDES,
    version: 0,
    name: "Corrections",
    order: OVERRIDES_ORDER,
    // Never regenerated. Along with the household's rules, the only data here
    // that cannot be rebuilt.
    authored: true,
    status: "effective",
    rules: [],
    createdAt: now.toISOString(),
  };
}

/** One transaction, one category, asserted. */
export function overrideRule(
  dedupKey: string,
  category: CategoryId,
  note?: string,
): Rule {
  return {
    matcher: { kind: "transaction", dedupKey },
    contributes: { kind: "assert", category },
    // `all`, not `debits`. Somebody correcting a specific transaction has looked
    // at it and knows which way the money went; the debit default exists to stop
    // a merchant pattern catching a salary, which cannot happen here.
    appliesTo: "all",
    ...(note === undefined ? {} : { note }),
  };
}

/** An override the rules have caught up with. */
export interface RedundantOverride {
  readonly dedupKey: string;
  readonly category: CategoryId;
  /** The set that now says the same thing without being told. */
  readonly agreedBy: string;
}

/** An override the rules disagree with — which names a rule defect. */
export interface ContradictedOverride {
  readonly dedupKey: string;
  /** What the person said. */
  readonly corrected: CategoryId;
  /** What the rules say, ignoring the override. */
  readonly rulesSay: CategoryId;
  readonly saidBy: string;
}

export interface OverrideReview {
  readonly total: number;
  /**
   * Overrides the rules now agree with.
   *
   * Manual state that can shrink instead of accumulating, which is the whole
   * reason to look: a correction list nobody prunes becomes a second rule set
   * with none of the machinery.
   */
  readonly redundant: readonly RedundantOverride[];
  /**
   * Overrides the rules contradict.
   *
   * Direct evidence of a rule defect, naming the set that produced the wrong
   * answer. More valuable than the correction itself: one override fixes one
   * transaction, and the rule behind it is wrong for every transaction like it.
   */
  readonly contradicted: readonly ContradictedOverride[];
  /** Overrides for transactions no longer in the corpus. */
  readonly orphaned: readonly string[];
}

/**
 * Compare every override with what the rules would say without it.
 *
 * Two passes rather than one: the answer with the override is what the ledger
 * shows, and the answer without it is the question being asked. Doing it any
 * other way means guessing which rule would have won.
 */
export function reviewOverrides(
  sets: readonly RuleSet[],
  corpus: readonly Candidate[],
): OverrideReview {
  const overrides = sets.find((s) => s.setId === OVERRIDES);
  if (!overrides || overrides.rules.length === 0) {
    return { total: 0, redundant: [], contradicted: [], orphaned: [] };
  }

  const without = sets.filter((s) => s.setId !== OVERRIDES);
  const byKey = new Map(corpus.map((c) => [c.dedupKey, c]));

  const redundant: RedundantOverride[] = [];
  const contradicted: ContradictedOverride[] = [];
  const orphaned: string[] = [];

  for (const rule of overrides.rules) {
    if (rule.matcher.kind !== "transaction") continue;
    const candidate = byKey.get(rule.matcher.dedupKey);
    if (!candidate) {
      // The transaction is gone, or outside the range being reviewed. Reported
      // rather than dropped: a correction pointing at nothing is either a stale
      // entry to remove or a range too narrow to judge it.
      orphaned.push(rule.matcher.dedupKey);
      continue;
    }

    const effective = evaluate(inPrecedenceOrder(without), candidate).effective;
    if (effective === undefined) continue;

    if (effective.category === rule.contributes.category) {
      redundant.push({
        dedupKey: rule.matcher.dedupKey,
        category: rule.contributes.category,
        agreedBy: effective.setId,
      });
      continue;
    }
    contradicted.push({
      dedupKey: rule.matcher.dedupKey,
      corrected: rule.contributes.category,
      rulesSay: effective.category,
      saidBy: effective.setId,
    });
  }

  return { total: overrides.rules.length, redundant, contradicted, orphaned };
}
