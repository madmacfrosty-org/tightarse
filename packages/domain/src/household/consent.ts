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
 *
 * Every field here is the provider's own statement rather than ours. Expiry
 * used to be computed as ninety days from connect, which happens to be right
 * and is still a guess about somebody else's policy; `/data/v1/me` says it, and
 * has been saying it into the raw zone all along.
 */
export const Consent = z.object({
  tenantId: TenantId,
  /** TrueLayer's `credentials_id`: its own name for this connection. */
  consentId: z.string().min(1),
  provider: z.literal("truelayer"),
  /** The bank, for a screen that would otherwise show a UUID. */
  institutionName: z.string().optional(),
  grantedAt: z.string(),
  expiresAt: z.string(),
  /**
   * The provider's own word for the state, carried verbatim and shown.
   *
   * **Nothing branches on this.** Their API reference types it as a bare string
   * with one example value and no enumeration, and the ledger holds a single
   * observation of a single state — so any set of values we wrote down would be
   * a guess dressed as a schema. `CategoryKind` spent months claiming totals
   * depended on it while nothing read it (#109); this does not make that claim.
   *
   * Whether a consent is in trouble is decided from `expiresAt`, which is a
   * date and can be reasoned about. If this ever needs to decide something,
   * there will be more than one observation to decide from.
   */
  providerStatus: z.string(),
  /**
   * When the provider last asserted all of the above.
   *
   * Load-bearing, unlike the status. A lapsed consent cannot be refreshed, so
   * it stops producing these rows — the row freezes rather than turning bad.
   * A reader that ignored this would show the last happy answer for ever.
   */
  seenAt: z.string(),
});
export type Consent = z.infer<typeof Consent>;
