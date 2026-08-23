/**
 * Applying rule sets to a transaction.
 *
 * Every set is evaluated, not just the first that matches. Within a set,
 * matching rules are folded in order; across sets, the effective answer is the
 * one from the lowest `order`. See docs/design/categorisation.md.
 *
 * Evaluating every set costs almost nothing once memoised on the merchant key,
 * and it buys the distinction that first-match-wins cannot express: two asserts
 * colliding inside one set is a genuine conflict, while an assert followed by a
 * refine is intended composition. Not being able to tell those apart is why a
 * supermarket forecourt read as a food shop 26 times.
 *
 * Pure, and deliberately so — no clock, no timing, no bound. A caller that wants
 * to know how long this took wraps the call; a caller worried about a
 * pathological pattern relies on its own execution limit, and the run is
 * idempotent so a killed one costs the batch rather than the work.
 */

import type { Candidate } from "./taxonomy.js";
import type { Rule, RuleSet } from "./rules.js";
import type { CategoryId } from "./category.js";

/** Why a set produced no answer, where it had something to say. */
export type SetProblem =
  /** Two rules asserted, so the set claims two answers with equal authority. */
  | { readonly kind: "conflict"; readonly categories: readonly CategoryId[] }
  /** A refine matched with nothing established. Names a missing assert. */
  | { readonly kind: "inertRefine"; readonly category: CategoryId };

export interface SetOutcome {
  readonly setId: string;
  readonly version: number;
  readonly order: number;
  /** What this set concluded, if anything. */
  readonly category?: CategoryId | undefined;
  /** Everything worth reporting about how it got there. */
  readonly problems: readonly SetProblem[];
}

export interface Evaluation {
  /**
   * The answer. The lowest-ordered set that produced one.
   *
   * Undefined when no set matched, which is an ordinary outcome — it is the
   * backlog, not a failure.
   */
  readonly effective?: { readonly setId: string; readonly version: number; readonly category: CategoryId } | undefined;
  /** Every set, in the order they were evaluated. */
  readonly sets: readonly SetOutcome[];
}

/** Does this rule apply to this transaction at all? */
export function matches(rule: Rule, candidate: Candidate): boolean {
  // Credits are excluded unless a rule says otherwise. An employer sharing a
  // name with a retailer once filed £62,868 of salary as Shopping.
  if (rule.appliesTo === "debits" && candidate.amount >= 0) return false;
  // And a credits-only rule is how direction decides a category outright:
  // interest is Income when received and Fees & Charges when paid.
  if (rule.appliesTo === "credits" && candidate.amount < 0) return false;

  const m = rule.matcher;
  switch (m.kind) {
    case "merchant":
      // Case-insensitive because descriptions arrive in whatever case the
      // provider felt like, and the same merchant is not two merchants.
      return new RegExp(m.pattern, "i").test(candidate.description);
    case "providerCategory":
      return candidate.providerCategory === m.value;
    case "transaction":
      return candidate.dedupKey === m.dedupKey;
  }
}

/**
 * Fold one set's rules over a transaction.
 *
 * Order within the set is data, so the fold is deterministic. A set produces at
 * most one category, which keeps cardinality sane and makes "what did each
 * source say" answerable.
 */
export function foldSet(set: RuleSet, candidate: Candidate): SetOutcome {
  const problems: SetProblem[] = [];
  let category: CategoryId | undefined;
  const asserted: CategoryId[] = [];

  for (const rule of set.rules) {
    if (!matches(rule, candidate)) continue;
    const c = rule.contributes;

    if (c.kind === "assert") {
      asserted.push(c.category);
      category ??= c.category;
      continue;
    }

    // A refine cannot originate a category. A qualifier matching with nothing
    // established names a missing assert, which is worth reporting: it is the
    // shape of "we know this is a forecourt but not whose".
    if (category === undefined) {
      problems.push({ kind: "inertRefine", category: c.category });
      continue;
    }
    category = c.category;
  }

  if (asserted.length > 1) {
    // The set is claiming two answers with equal authority, so it claims
    // nothing usable. Evaluation falls through to the next set rather than
    // leaving the transaction uncategorised over a rule defect — the conflict
    // is reported instead.
    return {
      setId: set.setId,
      version: set.version,
      order: set.order,
      problems: [{ kind: "conflict", categories: asserted }, ...problems],
    };
  }

  return {
    setId: set.setId,
    version: set.version,
    order: set.order,
    ...(category === undefined ? {} : { category }),
    problems,
  };
}

/**
 * Evaluate every set, and say which answer stands.
 *
 * Lower `order` wins, so a household set is 0 and new sets append below without
 * renumbering what sits above them. Precedence is data rather than load order
 * precisely so that an imported rule can never outrank a hand-written one by
 * accident.
 */
export function evaluate(sets: readonly RuleSet[], candidate: Candidate): Evaluation {
  const outcomes = [...sets]
    .sort((a, b) => a.order - b.order || a.setId.localeCompare(b.setId))
    .map((set) => foldSet(set, candidate));

  const winner = outcomes.find((o) => o.category !== undefined);

  return {
    ...(winner?.category === undefined
      ? {}
      : { effective: { setId: winner.setId, version: winner.version, category: winner.category } }),
    sets: outcomes,
  };
}
