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
import { Category } from "../categorisation/category.js";
import { RuleSet } from "../categorisation/rules.js";
import type { Categories, RuleProposer, RuleSets, Transactions } from "../ports/outbound/index.js";
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
  /**
   * The catalogue, for checking that a proposal names categories that exist.
   *
   * Rules are data, so a category id inside one is a reference someone typed or
   * a model produced. Unchecked, it is a rule that matches happily and then
   * asserts a category nothing can resolve.
   */
  readonly categories: Categories;
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


/** What proposing did to one set. */
export interface Proposed {
  readonly setId: string;
  /** The version written, waiting on a decision. */
  readonly version: number;
  readonly rules: number;
}

/**
 * Record a proposal, without acting on it.
 *
 * Every rule change is a proposal — a person with an editor, a pass over
 * conflicts, or a model — and it is written as the next version of its set,
 * marked `proposed`. That version is readable and reviewable without changing
 * what the fold does, which is what makes reviewing it worth anything.
 *
 * Versions are assigned here rather than taken from the proposal. A proposer
 * knows what the rules should be; it has no business deciding where they sit in
 * a history it cannot see.
 */
export async function propose(
  deps: Pick<OptimiseDependencies, "ruleSets" | "categories">,
  tenantId: string,
  proposed: readonly RuleSet[],
  options: { readonly now: Date; readonly by: string },
): Promise<Proposed[]> {
  const current = await currentSets(deps, tenantId);

  // Checked before anything is written, so a proposal naming a category that
  // does not exist fails whole rather than half.
  const unknown = await unknownCategories(deps, tenantId, proposed);
  if (unknown.length > 0) {
    throw new Error(`Refusing rules naming categories that do not exist or are retired: ${unknown.join(", ")}`);
  }

  const out: Proposed[] = [];
  for (const set of proposed) {
    const next: RuleSet = {
      ...set,
      version: (current.get(set.setId)?.version ?? 0) + 1,
      status: "proposed",
      createdAt: options.now.toISOString(),
      createdBy: options.by,
    };
    await deps.ruleSets.putRuleSetVersion(tenantId, next);
    out.push({ setId: next.setId, version: next.version, rules: next.rules.length });
  }
  return out;
}

/**
 * Whether a proposal may be approved without a person looking at it.
 *
 * Two conditions, and both have to hold.
 *
 * An `authored` set is never auto-approved. A derived proposal MAY touch one —
 * simplifying three rules into one can legitimately make a hand-written special
 * case redundant, and refusing to propose that means never being offered it —
 * but replacing what somebody wrote is a decision for them.
 *
 * And nothing that gets worse is approved. Fewer conflicts with no new gaps is
 * a machine-checkable improvement; anything else is a judgement, and the point
 * of measuring before and after is to know which one you are looking at.
 */
export function mayApproveAutomatically(
  report: OptimiseReport,
  current: ReadonlyMap<string, RuleSet>,
): { readonly allowed: boolean; readonly because: string } {
  const authored = report.proposed.filter((s) => current.get(s.setId)?.authored === true).map((s) => s.setId);
  if (authored.length > 0) {
    return { allowed: false, because: `replaces an authored set: ${authored.join(", ")}` };
  }

  const i = report.improvement;
  if (i === undefined) return { allowed: false, because: "nothing was proposed" };
  if (i.gaps.after > i.gaps.before) {
    return { allowed: false, because: `${i.gaps.after - i.gaps.before} more merchants would match nothing` };
  }
  if (i.conflicts.after > i.conflicts.before) {
    return { allowed: false, because: `${i.conflicts.after - i.conflicts.before} more conflicts` };
  }
  if (i.inertRefines.after > i.inertRefines.before) {
    return { allowed: false, because: `${i.inertRefines.after - i.inertRefines.before} more inert refines` };
  }
  return { allowed: true, because: "fewer conflicts, no new gaps, nothing authored replaced" };
}

/** What deciding a proposal did. */
export interface Decided {
  readonly setId: string;
  readonly version: number;
  readonly status: "effective" | "rejected";
}

/**
 * Accept or reject proposals.
 *
 * Rejection carries a reason and is recorded, because a declined proposal that
 * leaves no trace is one the next run makes again, and the day after.
 *
 * Accepting does not touch a transaction. Applying rules to the ledger is
 * `categorise`, deliberately separate: a rule change and its effect are
 * different decisions, and the second is re-runnable.
 */
export async function decide(
  deps: Pick<OptimiseDependencies, "ruleSets">,
  tenantId: string,
  proposals: readonly Pick<Proposed, "setId" | "version">[],
  decision: { readonly status: "effective" } | { readonly status: "rejected"; readonly because: string },
): Promise<Decided[]> {
  const out: Decided[] = [];
  for (const p of proposals) {
    await deps.ruleSets.decideRuleSetVersion(tenantId, p.setId, p.version, decision);
    out.push({ setId: p.setId, version: p.version, status: decision.status });
  }
  return out;
}

async function currentSets(
  deps: Pick<OptimiseDependencies, "ruleSets">,
  tenantId: string,
): Promise<Map<string, RuleSet>> {
  return new Map(
    (await deps.ruleSets.listRuleSets(tenantId)).map((r) => RuleSet.parse(r)).map((s) => [s.setId, s]),
  );
}

/**
 * Category references in a proposal that nothing can resolve.
 *
 * Retired counts as unknown. A retired category still resolves for rows already
 * pointing at it — that is why categories are never deleted — but a NEW rule
 * choosing one is someone reaching for something deliberately withdrawn.
 */
async function unknownCategories(
  deps: Pick<OptimiseDependencies, "categories">,
  tenantId: string,
  proposed: readonly RuleSet[],
): Promise<string[]> {
  const referenced = new Set<string>();
  for (const set of proposed) {
    for (const rule of set.rules) referenced.add(rule.contributes.category);
  }
  if (referenced.size === 0) return [];

  const catalogue = (await deps.categories.listCategories(tenantId)).map((r) => Category.parse(r));
  const usable = new Set(catalogue.filter((c) => !c.retired).map((c) => c.id));
  return [...referenced].filter((id) => !usable.has(id)).sort();
}

export { currentSets, unknownCategories };
