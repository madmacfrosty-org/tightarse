/**
 * Household-wide decisions, where one person's choice applies to a shared ledger.
 */

import { z } from "zod";
import { Currency } from "../money.js";
import { EnrichmentMode } from "../categorisation/enrichment.js";
import { TenantId } from "./member.js";

export const TenantSettings = z.object({
  tenantId: TenantId,
  enrichment: EnrichmentMode,
  baseCurrency: Currency.default("GBP"),
  updatedAt: z.string().datetime(),
});
export type TenantSettings = z.infer<typeof TenantSettings>;

/**
 * Which household a person belongs to.
 *
 * Created by an administrator, never by the person signing in. With federated
 * login there is no password to gate on — anyone with a Google account could
 * reach the sign-in screen — so this record is what decides whether a verified
 * identity gets a household claim at all.
 *
 * No membership record means no claim, and no claim means the API refuses. It
 * fails closed by construction rather than by a check someone might remove.
 */
