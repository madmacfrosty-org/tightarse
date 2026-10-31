/**
 * Who may see a household's ledger.
 *
 * Everyone in a household sees every transaction in it. There is no per-member
 * scoping of data and none is planned — one aggregated ledger is the point.
 */

import { z } from "zod";

export const TenantId = z.string().min(1).max(64);

export const Member = z.object({
  /** Verified email from the identity provider, lowercased. */
  email: z.string().email(),
  tenantId: TenantId,
  addedAt: z.string().datetime(),
  /**
   * What this person may do beyond reading.
   *
   * Defaulted to `admin`, which is what every member created before this
   * existed is: a migration that silently demoted people would be a support
   * call, and the household had no way to promote anybody back.
   *
   * The split is in `docs/design/tenancy.md`. The short version: anything
   * that spends a consent, ends one, or changes who can see the household.
   * Reading and categorising are open to everyone, because categorising is
   * corrigible and a household where only one person may tidy the books is
   * one where the books do not get tidied.
   */
  role: z.enum(["admin", "member"]).default("admin"),
});
export type Member = z.infer<typeof Member>;
