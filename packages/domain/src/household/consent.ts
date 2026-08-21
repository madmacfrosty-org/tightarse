/**
 * A bank authorisation, and what it permits.
 *
 * Deep history is one-shot per consent: roughly an hour after authorisation only
 * ninety days remain available, for ever.
 */

import { z } from "zod";
import { TenantId } from "./member.js";

/**
 * Consent expires every 90 days under FCA rules — the AISP must obtain
 * reconfirmation or the feed stops. Tracked explicitly so we can nudge early.
 */
export const Consent = z.object({
  tenantId: TenantId,
  consentId: z.string().min(1),
  provider: z.literal("truelayer"),
  grantedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  status: z.enum(["active", "expiring", "expired", "revoked"]),
});
export type Consent = z.infer<typeof Consent>;
