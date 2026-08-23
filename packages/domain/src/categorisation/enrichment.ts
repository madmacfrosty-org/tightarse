/**
 * What survives of the enrichment era.
 *
 * Both are still live and both keep their names because the names describe the
 * data: `EnrichmentMode` is the household setting literally called `enrichment`,
 * and `CustomRule` is the shape of the legacy rules row, which is read once by
 * the seed and never written.
 *
 * The enrichment ROWS, their port and their adapter are gone — categorisations
 * replaced them. Nothing here writes anything.
 */

import { z } from "zod";

/**
 * How a household's transactions get categorised.
 *
 *   off    provider payment type only — mechanism, not purpose
 *   rules  deterministic merchant rules; nothing leaves the account
 *   model  rules first, then a model for whatever they did not match
 *
 * Explicit rather than implied by whether the categoriser has run, so "no
 * categories" is a stated choice rather than an unfinished job.
 */
/**
 * Whether to categorise this household at all.
 *
 * `model` is a legacy value: nothing has classified with a model since that path
 * was deleted, and rules are the only thing categorisation does. Kept so stored
 * settings still parse — a household that chose it gets its rules applied, which
 * is what it was asking for.
 */
export const EnrichmentMode = z.enum(["off", "rules", "model"]);
export type EnrichmentMode = z.infer<typeof EnrichmentMode>;

/**
 * A household's own categorisation rule.
 *
 * Kept in the table rather than the repository, and that is the entire point.
 * The generic rules in `agents/categoriser` are national chains that apply to
 * anyone. A household's real statement is not: its highest-volume descriptions
 * are family names, an employer, a named individual paid regularly, and its own
 * sort codes and account numbers. Committing rules for those to a public repo
 * would publish exactly what the repo is careful never to hold.
 *
 * So personal rules are DATA. They live beside the ledger they describe, under
 * the same encryption and the same access control.
 */
export const CustomRule = z.object({
  /** Case-insensitive regular expression matched against the description. */
  pattern: z.string().min(2),
  category: z.string().min(1),
  /** Optional reminder of why this exists. */
  note: z.string().optional(),
  addedAt: z.string().datetime(),
});
export type CustomRule = z.infer<typeof CustomRule>;
