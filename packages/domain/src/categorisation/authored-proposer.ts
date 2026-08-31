/**
 * Proposals from a person.
 *
 * The third driver of one use case, and the one that makes rules genuinely
 * operational: narrowing a bad pattern stops being a code change, a pull
 * request and a deploy, and becomes a proposal measured against the real ledger
 * and accepted or not.
 *
 * Two shapes, because a person works in two ways. `editing` changes one field
 * of one rule, which is what most fixes are — a pattern that matched motorway
 * services when it meant fuel. `replacing` takes whole sets from a file, which
 * is the general form and exactly what a model will produce, so both go through
 * the same checks rather than the file route being invented later.
 */

import type { Rule, RuleProposer, RuleSet } from "../index.js";

export interface Edit {
  readonly setId: string;
  /** Position within the set, as the reports name it. */
  readonly index: number;
  readonly pattern?: string | undefined;
  readonly category?: string | undefined;
  readonly contributes?: "assert" | "refine" | undefined;
}

/** A person changing one field of one rule. */
export function editing(edit: Edit, by: string): RuleProposer {
  return {
    proposedBy: `authored:${by}`,
    propose: async (_evidence, sets) => {
      const set = sets.find((s) => s.setId === edit.setId);
      if (!set) throw new Error(`No set "${edit.setId}"`);

      const existing = set.rules[edit.index];
      if (!existing) throw new Error(`No rule ${edit.index} in "${edit.setId}" — it has ${set.rules.length}`);

      return [{ ...set, rules: set.rules.map((r, i) => (i === edit.index ? apply(r, edit) : r)) }];
    },
  };
}

/** A person, or anything else, supplying whole sets. */
export function replacing(sets: readonly RuleSet[], by: string): RuleProposer {
  return {
    proposedBy: `authored:${by}`,
    propose: async () => sets,
  };
}

function apply(rule: Rule, edit: Edit): Rule {
  const kind = edit.contributes ?? rule.contributes.kind;
  const category = edit.category ?? rule.contributes.category;
  return {
    ...rule,
    // Only a merchant matcher carries a pattern. Editing one on a rule matched
    // by provider category or dedup key is a mistake worth failing on rather
    // than silently ignoring.
    matcher:
      edit.pattern === undefined
        ? rule.matcher
        : mustBeMerchant(rule, edit.pattern),
    contributes: { kind, category },
  };
}

function mustBeMerchant(rule: Rule, pattern: string): Rule["matcher"] {
  if (rule.matcher.kind !== "merchant") {
    throw new Error(`Rule matches by ${rule.matcher.kind}, so it has no pattern to change`);
  }
  // Compiled here so an unparseable pattern fails at the proposal rather than
  // at the fold, where it would be one transaction into a re-application.
  new RegExp(pattern, "i");
  return { kind: "merchant", pattern };
}
