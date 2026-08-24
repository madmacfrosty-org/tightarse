/**
 * What a rule set is doing to a ledger, as numbers someone can act on.
 *
 * Gathered so that changing rules is a judgement about measured effect rather
 * than a guess. Every figure here is computed against the real corpus, which is
 * what turns "is this pattern too broad?" from an opinion into a count.
 *
 * Pure. The corpus arrives as an argument rather than being fetched, so the
 * caller decides the scope and this stays a function of what it is given.
 */

import { matches } from "./evaluate.js";
import type { Rule, RuleSet } from "./rules.js";
import type { Candidate } from "./taxonomy.js";

/** How much of the ledger one rule accounts for. */
export interface RuleReach {
  readonly setId: string;
  /** Position within the set, which is how the fold identifies it. */
  readonly index: number;
  /** Transactions this rule matches. */
  readonly transactions: number;
  /**
   * Distinct descriptions it matches.
   *
   * The number that says whether a pattern is too broad. 400 transactions at one
   * merchant is narrow and probably right; 400 across 200 merchants is a rule
   * that has escaped. A count of transactions alone cannot tell those apart,
   * which is how a generalisation from one branch of a shop reaches the chain.
   */
  readonly merchants: number;
}

/** A merchant nothing matched, and how much of the backlog it is. */
export interface Gap {
  readonly description: string;
  readonly transactions: number;
  /**
   * Money that left the household under it, positive minor units.
   *
   * Rules are worth writing in order of value, not frequency. The two orderings
   * disagree about most of their leading entries, because frequent gaps are
   * small recurring spends and valuable ones are not.
   */
  readonly outgoing: number;
}

export interface Evidence {
  /** Every rule, with what it reaches. Zero transactions means a dead rule. */
  readonly reach: readonly RuleReach[];
  /** Where a set claims two answers at once, by set. */
  readonly conflicts: readonly Conflict[];
  /** Qualifiers that matched with nothing established. Each names a missing assert. */
  readonly inertRefines: readonly InertRefine[];
  /**
   * The unmatched backlog, commonest first.
   *
   * Where new rules come from. Holds descriptions, so it is for a terminal or a
   * proposer in memory, and never for a file.
   */
  readonly gaps: readonly Gap[];
  readonly scanned: number;
}

export interface Conflict {
  readonly setId: string;
  /** The categories claimed at once. */
  readonly categories: readonly string[];
  /** Rule positions within the set that asserted them. */
  readonly rules: readonly number[];
  readonly transactions: number;
  /** One description it happens on, for a human deciding which rule is wrong. */
  readonly example: string;
}

export interface InertRefine {
  readonly setId: string;
  readonly index: number;
  readonly category: string;
  readonly transactions: number;
  readonly example: string;
}

/**
 * Measure a set of rules against a corpus.
 *
 * One pass per transaction per rule. That is 12,000 x 45 today, which is
 * nothing, and doing it honestly beats sampling: a rule that has escaped is
 * most visible in the transactions nobody thought to sample.
 */
export function gatherEvidence(sets: readonly RuleSet[], corpus: readonly Candidate[]): Evidence {
  const reach = new Map<string, { setId: string; index: number; transactions: number; merchants: Set<string> }>();
  const conflicts = new Map<string, { setId: string; categories: string[]; rules: number[]; transactions: number; example: string }>();
  const inert = new Map<string, InertRefine & { transactions: number }>();
  const gaps = new Map<string, { transactions: number; outgoing: number }>();

  for (const set of sets) {
    set.rules.forEach((_rule, index) => {
      reach.set(`${set.setId}#${index}`, { setId: set.setId, index, transactions: 0, merchants: new Set() });
    });
  }

  for (const candidate of corpus) {
    let matchedAnything = false;

    for (const set of sets) {
      const asserted: Array<{ index: number; category: string }> = [];
      let established: string | undefined;

      set.rules.forEach((rule: Rule, index: number) => {
        if (!matches(rule, candidate)) return;
        matchedAnything = true;

        // Non-null: every rule was seeded into `reach` above, so a miss here
        // would mean the two loops disagree about what the rules are.
        const r = reach.get(`${set.setId}#${index}`)!;
        r.transactions += 1;
        r.merchants.add(candidate.description);

        if (rule.contributes.kind === "assert") {
          asserted.push({ index, category: rule.contributes.category });
          established ??= rule.contributes.category;
          return;
        }
        if (established === undefined) {
          const k = `${set.setId}#${index}`;
          const existing = inert.get(k);
          if (existing) inert.set(k, { ...existing, transactions: existing.transactions + 1 });
          else
            inert.set(k, {
              setId: set.setId,
              index,
              category: rule.contributes.category,
              transactions: 1,
              example: candidate.description,
            });
          return;
        }
        established = rule.contributes.category;
      });

      if (asserted.length > 1) {
        // Keyed on which rules collided rather than on the transaction: thirty
        // transactions hitting one bad pair is one defect to fix, not thirty.
        const key = `${set.setId}#${asserted.map((a) => a.index).join(",")}`;
        const existing = conflicts.get(key);
        if (existing) existing.transactions += 1;
        else
          conflicts.set(key, {
            setId: set.setId,
            categories: asserted.map((a) => a.category),
            rules: asserted.map((a) => a.index),
            transactions: 1,
            example: candidate.description,
          });
      }
    }

    if (!matchedAnything) {
      const gap = gaps.get(candidate.description) ?? { transactions: 0, outgoing: 0 };
      gap.transactions += 1;
      if (candidate.amount < 0) gap.outgoing += -candidate.amount;
      gaps.set(candidate.description, gap);
    }
  }

  return {
    reach: [...reach.values()].map((r) => ({
      setId: r.setId,
      index: r.index,
      transactions: r.transactions,
      merchants: r.merchants.size,
    })),
    conflicts: [...conflicts.values()].sort((a, b) => b.transactions - a.transactions),
    inertRefines: [...inert.values()].sort((a, b) => b.transactions - a.transactions),
    gaps: [...gaps.entries()]
      .map(([description, g]) => ({ description, transactions: g.transactions, outgoing: g.outgoing }))
      .sort((a, b) => b.outgoing - a.outgoing || a.description.localeCompare(b.description)),
    scanned: corpus.length,
  };
}
