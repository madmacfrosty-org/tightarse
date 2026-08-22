/**
 * An account or a card, as the provider describes it.
 */

import { z } from "zod";
import { Amount, Currency } from "../money.js";
import { TenantId } from "../household/member.js";

/**
 * A tenant is a HOUSEHOLD, not a person. Everyone in the household shares one
 * ledger, which is what makes internal transfer detection possible at all —
 * netting a movement between two family members' accounts requires seeing both
 * sides. Multi-tenant from commit one; retrofitting it is a table migration.
 */
/**
 * An account's identifier.
 *
 * A string, and named only so that a `Record<AccountId, ...>` says what it is
 * keyed by. There is no branding: the ledger's ids come from the provider and
 * validating them beyond non-empty would be inventing a rule we do not have.
 */
export type AccountId = string;

export const Account = z.object({
  tenantId: TenantId,
  accountId: z.string().min(1),
  provider: z.literal("truelayer"),
  /** Provider's own identifier, opaque to us. */
  providerAccountId: z.string().min(1),
  displayName: z.string(),
  institutionName: z.string(),
  currency: Currency,
  /**
   * Whether this is a card rather than a bank account.
   *
   * Recorded from the endpoint the data came from, not inferred. The dashboard
   * previously guessed from balance relationships — a card was "available
   * greater than current" — which quietly failed for Amex, which reports no
   * available balance at all, and showed a debt of £567.90 as money in hand.
   *
   * It matters for presentation: a card's positive balance is what you OWE.
   */
  isCard: z.boolean().default(false),
  /** Provider's own account type, e.g. TRANSACTION. */
  accountType: z.string().optional(),
  /** Present only for accounts we have successfully fetched at least once. */
  lastSyncedAt: z.string().datetime().optional(),
});
export type Account = z.infer<typeof Account>;
