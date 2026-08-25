/**
 * Propose a change to the rules, and say what it would do.
 *
 * One use case rather than two, because previewing and proposing are the same
 * computation on the same side of the authorisation boundary: whoever may
 * propose may ask what a proposal would do first. A dry run is the real thing
 * with the write skipped, so the two can never drift apart and report different
 * numbers for the same change.
 *
 * The prediction is computed HERE, never accepted from a caller. A proposal that
 * carried its own account of its effect would defeat the arrangement this design
 * rests on, where a model may write rules and only deterministic code says what
 * they do.
 *
 * Accepting is somewhere else entirely. This writes a version marked `proposed`
 * and stops; making it effective is a decision, and a decision belongs to a
 * person.
 */

import { preview } from "../categorisation/preview.js";
import type { Preview } from "../categorisation/preview.js";
import { RuleSet } from "../categorisation/rules.js";
import type { Candidate } from "../categorisation/taxonomy.js";
import type { DateRange } from "../ports/index.js";
import type { Categories, Row, RuleSets, Transactions } from "../ports/outbound/index.js";
import { candidateOf } from "./candidate.js";
import { propose, unknownCategories } from "./optimise.js";
import type { Proposed } from "./optimise.js";

export interface ProposalDeps {
  readonly transactions: Transactions;
  readonly ruleSets: RuleSets;
  /**
   * The catalogue, for checking that a proposal names categories that exist.
   *
   * Checked on a dry run too. A caller asking what a change would do deserves to
   * be told the change is unwritable, rather than finding out when they mean it.
   */
  readonly categories: Categories;
}

export interface ProposalCommand {
  /** The sets as they would be. Sets left out are unchanged. */
  readonly sets: readonly RuleSet[];
  /** Compute and return, writing nothing. */
  readonly dryRun: boolean;
  readonly by: string;
  readonly now: Date;
  /** Which transactions to measure against. */
  readonly range: DateRange;
}

export interface ProposalOutcome {
  readonly prediction: Preview;
  /** What was written. Absent on a dry run, which creates nothing. */
  readonly proposed?: readonly Proposed[];
}

function parseSets(rows: readonly Row[]): RuleSet[] {
  const sets: RuleSet[] = [];
  for (const row of rows) {
    const parsed = RuleSet.safeParse(row);
    if (parsed.success) sets.push(parsed.data);
  }
  return sets;
}

/**
 * The arrangement the proposal would produce.
 *
 * Versions are advanced here to match what `propose` will assign, because
 * `preview` identifies what changed by version. A proposal carrying the version
 * it already has would be previewed as touching nothing at all — an empty
 * result that looks like a harmless change rather than a broken one.
 */
function arrangementAfter(before: readonly RuleSet[], proposedSets: readonly RuleSet[]): RuleSet[] {
  const next = new Map(before.map((s) => [s.setId, s]));
  for (const set of proposedSets) {
    const version = (next.get(set.setId)?.version ?? 0) + 1;
    next.set(set.setId, { ...set, version, status: "effective" });
  }
  return [...next.values()];
}

export async function proposeRules(
  deps: ProposalDeps,
  tenantId: string,
  request: ProposalCommand,
): Promise<ProposalOutcome> {
  const [{ transactions }, currentRows] = await Promise.all([
    deps.transactions.listRange(tenantId, request.range),
    deps.ruleSets.listRuleSets(tenantId),
  ]);

  // Before anything is computed, and before the dry-run branch. A caller asking
  // what a change would do deserves to be told the change is unwritable, rather
  // than finding out when they mean it.
  const unknown = await unknownCategories({ categories: deps.categories }, tenantId, request.sets);
  if (unknown.length > 0) {
    throw new Error(`Refusing rules naming categories that do not exist or are retired: ${unknown.join(", ")}`);
  }

  const before = parseSets(currentRows);
  const after = arrangementAfter(before, request.sets);
  const corpus: Candidate[] = transactions.map(candidateOf);

  const prediction = preview(before, after, corpus);

  if (request.dryRun) return { prediction };

  const proposed = await propose(
    { ruleSets: deps.ruleSets, categories: deps.categories },
    tenantId,
    request.sets,
    { now: request.now, by: request.by },
  );
  return { prediction, proposed };
}

export type { Preview, Proposed };
