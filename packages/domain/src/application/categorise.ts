/**
 * Categorise a household's backlog.
 *
 * Two drivers reach this: a schedule that runs rules only, and an operator who
 * chooses to spend money on the model. They used to be two loops over the same
 * ledger with the same bugs available to each independently — the command-line
 * one had its own copy of the write, so a fix to one did not reach the other.
 *
 * Rules first, always, and written before the model runs. The deterministic
 * half costs nothing and is reproducible; if a model call then fails, what was
 * free is already saved and the run resumes rather than restarting.
 *
 * Idempotent throughout. An already-enriched transaction is not in the backlog,
 * so re-running costs nothing.
 */

import { prepare, writeEnrichments } from "../categorisation/categorising.js";
import { RULES_VERSION } from "../categorisation/merchant-rules.js";
import type { Candidate, Classification } from "../categorisation/taxonomy.js";
import type { EnrichmentMode } from "../categorisation/enrichment.js";
import type { CategoriserReads, Classifier } from "../ports/outbound/index.js";
import type { DateRange } from "../ports/index.js";

/**
 * How many candidates go to the classifier at once.
 *
 * Here rather than in the adapter because it decides how much work is lost when
 * a call fails: each batch is written before the next is requested, so this is
 * the resumption granularity, not a detail of anyone's token limit.
 */
export const BATCH_SIZE = 40;

export interface CategoriseDeps {
  readonly ledger: CategoriserReads;
  /**
   * Absent means rules only. The schedule leaves it out deliberately — the model
   * costs money per run and that belongs to someone deciding to spend it, not to
   * something that spends it at 06:00 whether or not anyone looks.
   */
  readonly classifier?: Classifier | undefined;
}

export interface CategoriseOptions {
  readonly range: DateRange;
  readonly limit?: number | undefined;
  /** Overrides the household setting. An operator may run the model once. */
  readonly mode?: EnrichmentMode | undefined;
  /** Stamped on every enrichment written by this run. */
  readonly now: Date;
  /** Classify and count, write nothing. */
  readonly dryRun?: boolean | undefined;
}

export interface CategoriseReport {
  readonly mode: EnrichmentMode;
  /** True when the household has enrichment off and nothing was attempted. */
  readonly skipped: boolean;
  readonly backlog: number;
  readonly matchedByRules: number;
  readonly unmatched: number;
  readonly written: number;
  readonly customRules: number;
  /** Model answers outside the taxonomy. */
  readonly rejected: number;
  /** Candidates the model did not answer for; they stay in the backlog. */
  readonly missing: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly tally: ReadonlyMap<string, number>;
  /**
   * Everything assigned this run, and the candidates behind them.
   *
   * Carried so a dry run can show which transaction got which category —
   * a distribution can look entirely plausible while individual rows are wrong.
   * In memory only: these hold descriptions, which are merchants and people's
   * names, and nothing here writes them anywhere.
   */
  readonly assignments: readonly Classification[];
  readonly candidates: readonly Candidate[];
}

export async function categorise(
  deps: CategoriseDeps,
  tenantId: string,
  options: CategoriseOptions,
): Promise<CategoriseReport> {
  const { ledger } = deps;

  // Mode is a household setting and "off" means off. A schedule must respect it,
  // or turning enrichment off would silently keep doing the thing.
  const settings = await ledger.getSettings(tenantId);
  const mode = options.mode ?? settings?.enrichment ?? "rules";
  if (mode === "off") return empty(mode, true);

  const prepared = await prepare(ledger, tenantId, options.range, options.limit);
  const producedAt = options.now.toISOString();
  const tally = new Map<string, number>();
  const assignments: Classification[] = [...prepared.classifications];

  let written = 0;
  const rules = options.dryRun
    ? { written: 0, tally: countInto(new Map(), prepared.classifications) }
    : await writeEnrichments(ledger, tenantId, prepared.classifications, prepared.timestamps, RULES_VERSION, producedAt);
  written += rules.written;
  merge(tally, rules.tally);

  let rejected = 0;
  let missing = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  // The model only runs when the mode asks for it AND a classifier was supplied.
  // Asking for "model" without one is rules-only rather than an error: the
  // schedule and the command line differ in exactly this, and a household that
  // has chosen "model" should still get its rules applied on the daily run.
  const classifier = mode === "model" ? deps.classifier : undefined;
  if (classifier) {
    for (let i = 0; i < prepared.unmatched.length; i += BATCH_SIZE) {
      const batch = prepared.unmatched.slice(i, i + BATCH_SIZE);
      const result = await classifier.classify(batch);
      inputTokens += result.inputTokens;
      outputTokens += result.outputTokens;
      rejected += result.rejected;
      missing += result.missing;
      assignments.push(...result.classifications);

      // Written per batch, before the next call is made: a failure half way
      // through 9,653 transactions should cost the batch in flight, not the run.
      const batchWrite = options.dryRun
        ? { written: 0, tally: countInto(new Map(), result.classifications) }
        : await writeEnrichments(
            ledger,
            tenantId,
            result.classifications,
            prepared.timestamps,
            classifier.producedBy,
            producedAt,
          );
      written += batchWrite.written;
      merge(tally, batchWrite.tally);
    }
  }

  return {
    mode,
    skipped: false,
    backlog: prepared.candidates.length,
    matchedByRules: prepared.classifications.length,
    unmatched: prepared.unmatched.length,
    written,
    customRules: prepared.customRuleCount,
    rejected,
    missing,
    inputTokens,
    outputTokens,
    tally,
    assignments,
    candidates: prepared.candidates,
  };
}

function empty(mode: EnrichmentMode, skipped: boolean): CategoriseReport {
  return {
    mode,
    skipped,
    backlog: 0,
    matchedByRules: 0,
    unmatched: 0,
    written: 0,
    customRules: 0,
    rejected: 0,
    missing: 0,
    inputTokens: 0,
    outputTokens: 0,
    tally: new Map(),
    assignments: [],
    candidates: [],
  };
}

/** A dry run still reports what it would have assigned, so it counts without writing. */
function countInto(tally: Map<string, number>, cs: readonly Classification[]): Map<string, number> {
  for (const c of cs) tally.set(c.category, (tally.get(c.category) ?? 0) + 1);
  return tally;
}

function merge(into: Map<string, number>, from: ReadonlyMap<string, number>): void {
  for (const [k, n] of from) into.set(k, (into.get(k) ?? 0) + n);
}
