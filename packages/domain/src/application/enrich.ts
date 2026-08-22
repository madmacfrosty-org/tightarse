/**
 * Enrich a household's backlog by applying its merchant rules.
 *
 * Named for what it does. It writes `TransactionEnrichment` rows, and the
 * household setting that governs it is `enrichment` — while `categorise` is now
 * the operation over versioned rule sets that replaces this. Two things called
 * categorisation, doing different things, is how you end up unable to say which
 * one produced a row.
 *
 * Deterministic, and deliberately so. Rules are data; applying them is
 * mechanical; the same rules over the same transactions give the same answer
 * every time. That is what makes a categorisation reproducible, which in turn is
 * what allows re-application to be total rather than having to tiptoe around
 * rows nothing can regenerate. See docs/design/categorisation.md.
 *
 * A model has no part in this. Where one is used later it will propose rules for
 * review, never classify a transaction — model output is not reproducible, and a
 * categorisation derived from it would have to be materialised, excluded from
 * re-application and never regenerated, which is the exception that the whole
 * model is shaped to avoid.
 *
 * Two drivers reach this: a schedule, and an operator on the command line. They
 * used to be two loops over the same ledger with their own copies of the write,
 * so a fix to one never reached the other.
 *
 * Idempotent. An already-enriched transaction is not in the backlog, so
 * re-running costs nothing.
 */

import { prepare, writeEnrichments } from "../categorisation/categorising.js";
import { RULES_VERSION } from "../categorisation/merchant-rules.js";
import type { Candidate, Classification } from "../categorisation/taxonomy.js";
import type { EnrichmentMode } from "../categorisation/enrichment.js";
import type { CategoriserReads } from "../ports/outbound/index.js";
import type { DateRange } from "../ports/index.js";

export interface EnrichDependencies {
  /** The backlog, the household's rules, and where a result is written. */
  readonly ledger: CategoriserReads;
}

export interface EnrichOptions {
  /** The window to categorise. */
  readonly range: DateRange;
  /** Cap the backlog read, for a sample run. */
  readonly limit?: number | undefined;
  /** Overrides the household setting. */
  readonly mode?: EnrichmentMode | undefined;
  /** Stamped on every enrichment written by this run. */
  readonly now: Date;
  /** Apply and count, write nothing. */
  readonly dryRun?: boolean | undefined;
}

export interface EnrichReport {
  /** The mode this run actually used. */
  readonly mode: EnrichmentMode;
  /** True when the household has enrichment off and nothing was attempted. */
  readonly skipped: boolean;
  /** Transactions in the window with no categorisation yet. */
  readonly backlog: number;
  /** How many of those the rules placed. */
  readonly matched: number;
  /** How many the rules could not place. They stay in the backlog. */
  readonly unmatched: number;
  /** How many enrichments were written. Differs from `matched` when a row vanished. */
  readonly written: number;
  /** How many of the household's own rules were loaded. */
  readonly customRules: number;
  /** How many landed in each category. */
  readonly tally: ReadonlyMap<string, number>;
  /**
   * What was assigned, and the candidates behind it.
   *
   * Carried so a dry run can show which transaction got which category — a
   * distribution can look plausible while individual rows are wrong. In memory
   * only: these hold descriptions, which are merchants and people's names.
   */
  readonly assignments: readonly Classification[];
  readonly candidates: readonly Candidate[];
}

export async function enrich(
  deps: EnrichDependencies,
  tenantId: string,
  options: EnrichOptions,
): Promise<EnrichReport> {
  const { ledger } = deps;

  // Mode is a household setting and "off" means off. A schedule must respect it,
  // or turning enrichment off would silently keep doing the thing.
  const settings = await ledger.getSettings(tenantId);
  const mode = options.mode ?? settings?.enrichment ?? "rules";
  if (mode === "off") {
    return {
      mode,
      skipped: true,
      backlog: 0,
      matched: 0,
      unmatched: 0,
      written: 0,
      customRules: 0,
      tally: new Map(),
      assignments: [],
      candidates: [],
    };
  }

  const prepared = await prepare(ledger, tenantId, options.range, options.limit);

  const { written, tally } = options.dryRun
    ? { written: 0, tally: count(prepared.classifications) }
    : await writeEnrichments(
        ledger,
        tenantId,
        prepared.classifications,
        prepared.timestamps,
        RULES_VERSION,
        options.now.toISOString(),
      );

  return {
    mode,
    skipped: false,
    backlog: prepared.candidates.length,
    matched: prepared.classifications.length,
    unmatched: prepared.unmatched.length,
    written,
    customRules: prepared.customRuleCount,
    tally,
    assignments: prepared.classifications,
    candidates: prepared.candidates,
  };
}

/** A dry run still reports what it would have assigned, so it counts without writing. */
function count(cs: readonly Classification[]): Map<string, number> {
  const tally = new Map<string, number>();
  for (const c of cs) tally.set(c.category, (tally.get(c.category) ?? 0) + 1);
  return tally;
}
