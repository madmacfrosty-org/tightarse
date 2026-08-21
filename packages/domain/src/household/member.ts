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
});
export type Member = z.infer<typeof Member>;
