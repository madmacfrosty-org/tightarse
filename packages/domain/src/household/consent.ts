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
  /** The provider's `consent_created_at`, as it sent it. */
  grantedAt: z.string(),
  /** The provider's `consent_expires_at`. The only thing anything judges on. */
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
   * When we asked, from the raw envelope. Always present; our clock.
   *
   * Named as `BalanceReading.fetchedAt` is, and meaning the same thing from the
   * same source — this is the moment of the fetch, not the provider's word for
   * anything.
   *
   * Load-bearing here, unlike the status. A lapsed consent cannot be refreshed,
   * so it stops producing these rows: the row freezes rather than turning bad,
   * and a reader ignoring this would show the last happy answer for ever.
   */
  fetchedAt: z.string(),
});
export type Consent = z.infer<typeof Consent>;

/** How a consent is doing, decided from its dates and nothing else. */
export type ConsentHealth = "ok" | "warn" | "escalate" | "expired" | "stale";

/**
 * What to make of a consent row.
 *
 * From the dates alone. The provider's status is carried for a reader to see
 * and decides nothing — see `Consent.providerStatus`.
 *
 * `stale` is the case that is easy to miss and the reason it is here. A lapsed
 * consent cannot be refreshed, so it stops producing rows: the row does not
 * turn bad, it stops moving. A reader that looked only at `expiresAt` would go
 * on showing a comfortable number about a feed that died weeks ago.
 */
export function consentHealth(
  consent: Pick<Consent, "expiresAt" | "fetchedAt">,
  opts: { now: Date; warnDays: number; escalateDays: number; staleAfterDays?: number },
): { health: ConsentHealth; daysRemaining: number } {
  const day = 864e5;
  const daysRemaining = Math.floor(
    (Date.parse(consent.expiresAt) - opts.now.getTime()) / day,
  );
  const sinceSeen = (opts.now.getTime() - Date.parse(consent.fetchedAt)) / day;
  // Two days: the sync runs daily, so one missed run is a blip and two is a
  // pattern. Deliberately shorter than any warning threshold — a feed that has
  // stopped is already the thing being warned about.
  if (sinceSeen > (opts.staleAfterDays ?? 2)) return { health: "stale", daysRemaining };
  if (daysRemaining < 0) return { health: "expired", daysRemaining };
  if (daysRemaining <= opts.escalateDays) return { health: "escalate", daysRemaining };
  if (daysRemaining <= opts.warnDays) return { health: "warn", daysRemaining };
  return { health: "ok", daysRemaining };
}
