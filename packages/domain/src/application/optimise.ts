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


/** What accepting a proposal did to one set. */
export interface Accepted {
  readonly setId: string;
  readonly from: number;
  readonly to: number;
  readonly rules: number;
}

/**
 * Publish a proposal as the next version of each set it changes.
 *
 * Separate from `optimise` on purpose. Measuring a proposal and adopting it are
 * different decisions, and collapsing them would mean every report carried the
 * power to change what the ledger says.
 *
 * Versions are assigned here rather than taken from the proposal. A proposer
 * knows what the rules should be; it has no business deciding where they sit in
 * a history it cannot see, and a published version is immutable precisely so a
 * categorisation's provenance keeps meaning what it said.
 */
export async function accept(
  deps: Pick<OptimiseDependencies, "ruleSets">,
  tenantId: string,
  proposed: readonly RuleSet[],
  options: { readonly now: Date; readonly by: string },
): Promise<Accepted[]> {
  const current = new Map(
    (await deps.ruleSets.listRuleSets(tenantId)).map((r) => RuleSet.parse(r)).map((s) => [s.setId, s]),
  );

  const accepted: Accepted[] = [];
  for (const set of proposed) {
    const existing = current.get(set.setId);

    // Custody, enforced rather than remembered. `authored` means nothing derived
    // may regenerate it — a person may edit their own rules, but a proposal is
    // by definition not a person, and "improve the rules" must not be an
    // operation capable of destroying the only data that cannot be rebuilt.
    if (existing?.authored === true) {
      throw new Error(`Refusing to replace the authored set "${set.setId}"`);
    }

    const next: RuleSet = {
      ...set,
      version: (existing?.version ?? 0) + 1,
      createdAt: options.now.toISOString(),
      createdBy: options.by,
    };
    await deps.ruleSets.putRuleSetVersion(tenantId, next);
    accepted.push({ setId: next.setId, from: existing?.version ?? 0, to: next.version, rules: next.rules.length });
  }
  return accepted;
}
