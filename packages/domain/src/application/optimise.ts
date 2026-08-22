/**
 * Improve a household's categorisation rules.
 *
 * Measure what the rules currently do to the ledger, ask whatever is proposing
 * changes what they should become, and measure that too. Reporting only — a
 * proposal is never written by this. Accepting one is a separate, deliberate
 * act, because it changes what every matching transaction says and, under
 * re-application, changes history with it.
 *
 * The proposer is a port, so a deterministic pass over conflicts, a person with
 * an editor, and a model reading the same evidence are the same use case with a
 * different opinion behind it. The default proposes nothing, which makes the
 * plain "what is wrong with my rules" report the same code path as everything
 * else rather than a branch.
 *
 * See docs/design/categorisation.md.
 */

import { candidateOf } from "./candidate.js";
import { gatherEvidence, type Evidence } from "../categorisation/evidence.js";
import { RuleSet } from "../categorisation/rules.js";
import type { Row, RuleProposer, RuleSets, Transactions } from "../ports/outbound/index.js";
import type { DateRange } from "../ports/index.js";

/**
 * A proposer that proposes nothing.
 *
 * The default, and not a placeholder: "report what the rules do and change
 * nothing" is the operation you want most of the time, and it deserves to be an
 * implementation rather than an absence with an `if` around it.
 */
export const noProposals: RuleProposer = {
  proposedBy: "none",
  propose: async () => [],
};

export interface OptimiseDependencies {
  readonly transactions: Transactions;
  readonly ruleSets: RuleSets;
  readonly proposer: RuleProposer;
}

export interface OptimiseOptions {
  readonly range: DateRange;
}

/** Whether a proposal is actually better, in the terms that matter. */
export interface Improvement {
  readonly conflicts: { readonly before: number; readonly after: number };
  readonly inertRefines: { readonly before: number; readonly after: number };
  /** Distinct merchants nothing matches. Coverage, measured where it is felt. */
  readonly gaps: { readonly before: number; readonly after: number };
  /** Rules matching nothing at all. Dead weight, before and after. */
  readonly deadRules: { readonly before: number; readonly after: number };
}

export interface OptimiseReport {
  readonly scanned: number;
  readonly before: Evidence;
  /** What the proposer suggested. Empty from the default. */
  readonly proposed: readonly RuleSet[];
  readonly proposedBy: string;
  /** What the proposal would do. Absent when nothing was proposed. */
  readonly after?: Evidence | undefined;
  readonly improvement?: Improvement | undefined;
}

export async function optimise(
  deps: OptimiseDependencies,
  tenantId: string,
  options: OptimiseOptions,
): Promise<OptimiseReport> {
  const sets = (await deps.ruleSets.listRuleSets(tenantId)).map((r) => RuleSet.parse(r));
  const { transactions } = await deps.transactions.listRange(tenantId, options.range);
  const corpus = transactions.map(candidateOf);

  const before = gatherEvidence(sets, corpus);
  const proposed = await deps.proposer.propose(before, sets);

  if (proposed.length === 0) {
    return { scanned: corpus.length, before, proposed: [], proposedBy: deps.proposer.proposedBy };
  }

  // Measured against the same corpus, so the two evidences are comparable. A
  // proposal judged against a different range would be judged against a
  // different ledger.
  const after = gatherEvidence(proposed, corpus);

  return {
    scanned: corpus.length,
    before,
    proposed,
    proposedBy: deps.proposer.proposedBy,
    after,
    improvement: {
      conflicts: { before: before.conflicts.length, after: after.conflicts.length },
      inertRefines: { before: before.inertRefines.length, after: after.inertRefines.length },
      gaps: { before: before.gaps.length, after: after.gaps.length },
      deadRules: { before: dead(before), after: dead(after) },
    },
  };
}

/** Rules matching nothing. A rule that never fires is a rule nobody can justify. */
function dead(evidence: Evidence): number {
  return evidence.reach.filter((r) => r.transactions === 0).length;
}

