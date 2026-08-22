/**
 * The rules half of categorisation, shared by the operator CLI and the Lambda.
 *
 * Both need to do exactly the same thing: read the backlog, load the
 * household's own rules, apply rules before any model, and write what matched.
 * Two implementations of that would drift, and the drift would be silent —
 * which is how a sign convention survived five years of totals being wrong.
 *
 * The model path stays in `run.ts`. It is an operator decision with a cost
 * attached, and it does not belong on a schedule.
 */

/**
 * The ledger, narrowed to what this file actually calls.
 *
 * Structural rather than the concrete class so a caller — notably the handler's
 * tests — can pass an object with these three methods and still be typechecked.
 * Taking the whole `Ledger` forced anything testing this path to construct a
 * real client, which needs a table and a region.
 */
export type BatchLedger = Omit<CategoriserReads, "getSettings">;
import { applyRules, compileCustom, RULES_VERSION } from "./merchant-rules.js";
import type { Candidate, Classification } from "./taxonomy.js";
import type { DateRange } from "../ports/index.js";
import type { CategoriserReads } from "../index.js";

export interface Prepared {
  candidates: Candidate[];
  timestamps: Map<string, string>;
  /** Matched by rules, deterministic. */
  classifications: Classification[];
  /** Everything rules could not place — the model's job, if it is enabled. */
  unmatched: Candidate[];
  customRuleCount: number;
}


/** Read the backlog and apply rules to it. Writes nothing. */
export async function prepare(
  ledger: BatchLedger,
  tenantId: string,
  range: DateRange,
  limit?: number,
): Promise<Prepared> {
  const backlog = await ledger.listToEnrich(tenantId, range, limit);

  const candidates: Candidate[] = backlog.map((r) => ({
    dedupKey: String(r["dedupKey"]),
    description: String(r["description"] ?? ""),
    amount: Number(r["amount"] ?? 0),
    currency: String(r["currency"] ?? "GBP"),
    ...(r["providerCategory"] ? { providerCategory: String(r["providerCategory"]) } : {}),
  }));
  const timestamps = new Map(backlog.map((r) => [String(r["dedupKey"]), String(r["timestamp"])]));

  // The household's own rules, which live in the table rather than the repo.
  const custom = compileCustom(await ledger.getCustomRules(tenantId));
  const ruled = applyRules(candidates, custom);

  return {
    candidates,
    timestamps,
    classifications: ruled.classifications,
    unmatched: ruled.unmatched,
    customRuleCount: custom.length,
  };
}



/**
 * Persist rule-derived enrichments.
 *
 * Idempotent: putEnrichment is a conditional write against the transaction, so
 * running this twice changes nothing and a partial run simply resumes.
 */
export async function writeRuleEnrichments(
  ledger: BatchLedger,
  tenantId: string,
  prepared: Pick<Prepared, "classifications" | "timestamps">,
  producedAt = new Date().toISOString(),
): Promise<{ written: number; tally: Map<string, number> }> {
  return writeEnrichments(ledger, tenantId, prepared.classifications, prepared.timestamps, RULES_VERSION, producedAt);
}

/**
 * Persist classifications, however they were produced.
 *
 * `producedBy` is the caller's because it is the difference between an
 * enrichment a rule can reproduce for free and one that cost a model call. The
 * rules path passes RULES_VERSION; the model path passes the classifier's own
 * label.
 */
export async function writeEnrichments(
  ledger: BatchLedger,
  tenantId: string,
  classifications: readonly Classification[],
  timestamps: ReadonlyMap<string, string>,
  producedBy: string,
  producedAt: string,
): Promise<{ written: number; tally: Map<string, number> }> {
  const tally = new Map<string, number>();
  let written = 0;

  for (const c of classifications) {
    const timestamp = timestamps.get(c.dedupKey);
    // No timestamp means the transaction vanished between listing and writing.
    // Skipping is correct: an enrichment with no transaction is orphaned.
    if (!timestamp) continue;
    await ledger.putEnrichment({
      tenantId,
      dedupKey: c.dedupKey,
      timestamp,
      category: c.category,
      confidence: c.confidence,
      producedBy,
      producedAt,
    });
    tally.set(c.category, (tally.get(c.category) ?? 0) + 1);
    written += 1;
  }

  return { written, tally };
}
