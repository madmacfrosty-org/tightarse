/**
 * The categorisation model being replaced, and the household's own overrides.
 *
 * `TransactionEnrichment` is the live path; `Categorisation` in this directory is
 * what supersedes it. Both exist while the changeover runs.
 */

import { z } from "zod";
import { TenantId } from "../household/member.js";

/**
 * Agent output lives in its own item type and never mutates a Transaction.
 * The ledger is deterministic; derived data is separate and re-computable.
 */
export const TransactionEnrichment = z.object({
  tenantId: TenantId,
  /** Identifies the transaction. Not `transactionId` — that is unstable. */
  dedupKey: z.string().min(1),
  /** Copied from the transaction so the enrichment's key can be derived
   *  without reading it back. */
  timestamp: z.string().datetime(),
  category: z.string(),
  /** Which agent/model produced this, so it can be invalidated wholesale. */
  producedBy: z.string(),
  producedAt: z.string().datetime(),
});
export type TransactionEnrichment = z.infer<typeof TransactionEnrichment>;

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
