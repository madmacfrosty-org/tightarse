/**
 * A proposer that resolves conflicts, deterministically.
 *
 * The first implementation of `RuleProposer`, and the reason the port exists
 * rather than a model being wired straight in: the same door, with an opinion
 * behind it that can be read, tested and argued with.
 *
 * The opinion is one rule: **where two asserts collide, the narrower becomes a
 * refine.** A pattern matching 1,900 transactions across 40 merchants is the one
 * naming the shop; one matching 60 at a single merchant is a qualifier. That is
 * exactly the supermarket-forecourt shape, and it falls out of the breadth
 * numbers without anyone listing cases by hand.
 *
 * It is a proposal, not a fix. Converting an assert to a refine changes that
 * rule for every transaction it matches, not only the ones in conflict — so a
 * rule whose matches are not a subset of the broader one will leave transactions
 * with nothing asserting a category at all. `optimise` measures that as gaps
 * before and after, which is what the report is for. Read it before accepting.
 */

import type { Evidence, Rule, RuleProposer, RuleSet } from "../index.js";

export const PROPOSED_BY = "conflict-resolver";

export function conflictResolver(): RuleProposer {
  return {
    proposedBy: PROPOSED_BY,
    propose: async (evidence, sets) => resolve(evidence, sets),
  };
}

export function resolve(evidence: Evidence, sets: readonly RuleSet[]): RuleSet[] {
  // Authored sets are left alone. A person may edit their own rules; a proposal
  // is by definition not a person, and custody has to be structural.
  const changeable = sets.filter((s) => !s.authored);
  const byRule = new Map(evidence.reach.map((r) => [`${r.setId}#${r.index}`, r]));

  const converted = new Map<string, Set<number>>();

  for (const conflict of evidence.conflicts) {
    const set = changeable.find((s) => s.setId === conflict.setId);
    if (!set) continue;

    // The narrower rule refines. Distinct merchants first, because that is what
    // says a pattern is specific rather than merely uncommon; transactions
    // break a tie, and the later position breaks that.
    const ranked = [...conflict.rules].sort((a, b) => {
      const ra = byRule.get(`${conflict.setId}#${a}`);
      const rb = byRule.get(`${conflict.setId}#${b}`);
      return (ra?.merchants ?? 0) - (rb?.merchants ?? 0) ||
        (ra?.transactions ?? 0) - (rb?.transactions ?? 0) ||
        b - a;
    });

    // Everything except the broadest becomes a refine, so a three-way collision
    // resolves in one pass rather than needing another round.
    for (const index of ranked.slice(0, -1)) {
      const forSet = converted.get(conflict.setId) ?? new Set<number>();
      forSet.add(index);
      converted.set(conflict.setId, forSet);
    }
  }

  if (converted.size === 0) return [];

  return changeable
    .filter((s) => converted.has(s.setId))
    .map((set) => ({
      ...set,
      rules: set.rules.map((rule, index) => convert(rule, converted.get(set.setId)?.has(index) === true)),
    }));
}

/** An assert becomes a refine for the same category; everything else is left. */
function convert(rule: Rule, shouldRefine: boolean): Rule {
  if (!shouldRefine || rule.contributes.kind !== "assert") return rule;
  return { ...rule, contributes: { kind: "refine", category: rule.contributes.category } };
}
