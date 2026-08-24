/**
 * What the rules do not yet cover, and what could be written to cover it.
 *
 * The use case behind proposing rules. It reads the ledger, works out what the
 * current rules make of every transaction, and collapses what is left into the
 * shapes a rule could be written against — descriptions, and amounts arriving on
 * a beat.
 *
 * Categories are derived by evaluating the rules here rather than read from the
 * stored categorisations. A stored category is what the last run concluded; a
 * proposer needs what the rules conclude *now*, and the two differ exactly when
 * rules changed and nothing has re-applied them yet. Reading the stale one would
 * hide the gaps a proposal is supposed to fill.
 */

import { summariseCorpus } from "../categorisation/corpus.js";
import type { Recurrence, DescriptionSummary, Sighting } from "../categorisation/corpus.js";
import { evaluate } from "../categorisation/evaluate.js";
import { gatherEvidence } from "../categorisation/evidence.js";
import type { Gap } from "../categorisation/evidence.js";
import { RuleSet } from "../categorisation/rules.js";
import type { Backlog, Inspection } from "../ports/inbound/index.js";
import type { DateRange } from "../ports/index.js";
import type { Row, RuleSets, Transactions } from "../ports/outbound/index.js";
import { candidateOf } from "./candidate.js";

export interface InspectDeps {
  readonly transactions: Transactions;
  readonly ruleSets: RuleSets;
}

/**
 * Rows that do not parse are skipped, not thrown.
 *
 * A scan returns whatever is stored, and one malformed rule set is not a reason
 * to refuse to describe a ledger. It matches nothing, which is the same thing it
 * would do during application.
 */
function parseSets(rows: readonly Row[]): RuleSet[] {
  const sets: RuleSet[] = [];
  for (const row of rows) {
    const parsed = RuleSet.safeParse(row);
    if (parsed.success) sets.push(parsed.data);
  }
  return sets;
}

export async function backlog(deps: InspectDeps, tenantId: string, range: DateRange): Promise<Backlog> {
  const [{ transactions }, setRows] = await Promise.all([
    deps.transactions.listRange(tenantId, range),
    deps.ruleSets.listRuleSets(tenantId),
  ]);
  const sets = parseSets(setRows);

  const sightings: Sighting[] = [];
  for (const row of transactions) {
    const candidate = candidateOf(row);
    const category = evaluate(sets, candidate).effective?.category;
    sightings.push({
      description: candidate.description,
      amount: candidate.amount,
      timestamp: String(row["timestamp"] ?? ""),
      ...(category === undefined ? {} : { category }),
    });
  }

  const summary = summariseCorpus(sightings);
  // Evidence is gathered over the same corpus rather than a second read, so the
  // gaps and the collapses cannot describe different ledgers.
  const evidence = gatherEvidence(sets, transactions.map(candidateOf));

  return {
    descriptions: summary.descriptions,
    recurrences: summary.recurrences,
    gaps: evidence.gaps,
    scanned: summary.scanned,
  };
}

export function inspection(deps: InspectDeps): Inspection {
  return { backlog: (tenantId, range) => backlog(deps, tenantId, range) };
}

export type { Backlog, DescriptionSummary, Gap, Recurrence };
