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

import { filterMatcher } from "../categorisation/evaluate.js";
import { OVERRIDES, OVERRIDES_ORDER } from "../categorisation/overrides.js";
import { preview } from "../categorisation/preview.js";
import type { Preview } from "../categorisation/preview.js";
import { RuleSet } from "../categorisation/rules.js";
import { categorise } from "./categorise.js";
import type { CategoriseReport } from "./categorise.js";
import type { Candidate } from "../categorisation/taxonomy.js";
import type { DateRange } from "../ports/index.js";
import type { Categorisations, Categories, Row, RuleSets, Transactions } from "../ports/outbound/index.js";
import { candidateOf } from "./candidate.js";
import { decide, propose, unknownCategories } from "./optimise.js";
import type { Proposed } from "./optimise.js";

export interface ProposalDeps {
  readonly transactions: Transactions;
  readonly ruleSets: RuleSets;
  /** Where an applied categorisation is recorded. Untouched unless asked to apply. */
  readonly categorisations: Categorisations;
  /**
   * The catalogue, for checking that a proposal names categories that exist.
   *
   * Checked on a dry run too. A caller asking what a change would do deserves to
   * be told the change is unwritable, rather than finding out when they mean it.
   */
  readonly categories: Categories;
}

/**
 * How far to take a proposal.
 *
 * One parameter with three values rather than two booleans, because
 * `dryRun && apply` is a combination with no meaning and every caller of a
 * two-boolean API eventually sends it.
 *
 * `propose` exists for a proposer that may not decide its own work — a model
 * outside the account, when there is one. A person at the keyboard with the
 * prediction in front of them is the case `mayApproveAutomatically` was written
 * for, and goes straight to `apply`.
 */
export type Commit = "preview" | "propose" | "apply";

/**
 * Categorise everything a filter matches.
 *
 * The filter, not a pattern: a term, a type, bounds on the amount. Built into a
 * matcher by `filterMatcher` — the same function the search that found those
 * transactions was built from — so the rule takes exactly what was on screen.
 * A client assembling the matcher itself would be a second implementation of
 * what decides which transactions a rule takes.
 *
 * At least one condition. A merchant rule with none would match the ledger.
 */
export interface MerchantRequest {
  readonly term?: string | undefined;
  readonly type?: string | undefined;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  readonly category: string;
}

/**
 * Categorise these transactions and no others.
 *
 * One rule per transaction, by dedup key, at override precedence. No leverage
 * and none intended: this is "that one is different", not a pattern, and a rule
 * that generalised would be answering a question nobody asked.
 */
export interface TransactionsRequest {
  readonly dedupKeys: readonly string[];
  readonly category: string;
}

export interface ProposalCommand {
  /** The sets as they would be. Sets left out are unchanged. */
  readonly sets?: readonly RuleSet[];
  /** Or: a term to categorise, from which the rule is built here. */
  readonly merchant?: MerchantRequest;
  /** Or: specific transactions, one rule each. */
  readonly transactions?: TransactionsRequest;
  readonly commit: Commit;
  /** Who to record as the author. */
  readonly by: string;
  readonly now: Date;
  /**
   * Which transactions to measure against, and — when applying — to apply to.
   *
   * The same range for both on purpose: a prediction measured over one span and
   * applied over another describes something that did not happen, and the
   * comparison between them stops meaning anything. Transactions outside it are
   * reached by the scheduled run, which works over the whole ledger.
   */
  readonly range: DateRange;
}

export interface ProposalOutcome {
  readonly prediction: Preview;
  /** What was written. Absent on a preview, which creates nothing. */
  readonly proposed?: readonly Proposed[];
  /** What applying actually did. Absent unless it was asked for. */
  readonly applied?: CategoriseReport;
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

/**
 * The set a merchant rule would produce: whatever is there, plus one rule.
 *
 * Appended rather than inserted, because order within a set is data and a rule
 * that quietly went first would change what the existing ones do.
 */
const HOUSEHOLD = { setId: "household", order: 0 } as const;
const OVERRIDES_TARGET = { setId: OVERRIDES, order: OVERRIDES_ORDER } as const;

function setWith(
  before: readonly RuleSet[],
  target: { setId: string; order: number },
  added: RuleSet["rules"],
): RuleSet {
  const existing = before.find((s) => s.setId === target.setId);
  return {
    setId: target.setId,
    version: existing?.version ?? 0,
    name: existing?.name ?? target.setId,
    order: existing?.order ?? target.order,
    authored: true,
    status: "effective",
    createdAt: existing?.createdAt ?? new Date(0).toISOString(),
    rules: [...(existing?.rules ?? []), ...added],
  };
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

  const before = parseSets(currentRows);
  // Where each kind of rule belongs is decided by what it means, not by the
  // caller. A merchant pattern is a household rule; naming one transaction
  // outright is an override. A client that could choose would eventually choose
  // wrong, and precedence is the thing that decides whose answer wins.
  // The rule is the filter. Built by the same function the search was, so a
  // screen showing rows and then writing a rule is writing the rule it showed.
  const matcher = request.merchant ? filterMatcher(request.merchant) : undefined;
  if (request.merchant && matcher === undefined) {
    throw new Error("A merchant rule needs at least one condition");
  }

  const sets = request.merchant
    ? [
        setWith(before, HOUSEHOLD, [
          {
            matcher: matcher!,
            contributes: { kind: "assert", category: request.merchant.category },
            appliesTo: "debits",
          },
        ]),
      ]
    : request.transactions
      ? [
          setWith(
            before,
            OVERRIDES_TARGET,
            request.transactions.dedupKeys.map((dedupKey) => ({
              matcher: { kind: "transaction" as const, dedupKey },
              contributes: { kind: "assert" as const, category: request.transactions!.category },
              // Not `debits`: a transaction named outright is that transaction,
              // and a direction gate on top could decline the very row asked for.
              appliesTo: "all" as const,
            })),
          ),
        ]
      : (request.sets ?? []);
  if (sets.length === 0) {
    throw new Error("A proposal needs sets, a merchant, or transactions to categorise");
  }

  // Before anything is computed, and before the preview branch. A caller asking
  // what a change would do deserves to be told the change is unwritable, rather
  // than finding out when they mean it.
  const unknown = await unknownCategories({ categories: deps.categories }, tenantId, sets);
  if (unknown.length > 0) {
    throw new Error(`Refusing rules naming categories that do not exist or are retired: ${unknown.join(", ")}`);
  }

  const after = arrangementAfter(before, sets);
  const corpus: Candidate[] = transactions.map(candidateOf);

  const prediction = preview(before, after, corpus);

  if (request.commit === "preview") return { prediction };

  const proposed = await propose(
    { ruleSets: deps.ruleSets, categories: deps.categories },
    tenantId,
    sets,
    { now: request.now, by: request.by },
  );
  if (request.commit === "propose") return { prediction, proposed };

  // Accepting points `current` at the version; applying is what reaches the
  // transactions. Separate calls because they are separate decisions, and the
  // second is re-runnable on its own.
  await decide({ ruleSets: deps.ruleSets }, tenantId, proposed, { status: "effective" });
  const applied = await categorise(
    { transactions: deps.transactions, ruleSets: deps.ruleSets, categorisations: deps.categorisations },
    tenantId,
    { range: request.range, now: request.now },
  );
  return { prediction, proposed, applied };
}

export type { Preview, Proposed };
