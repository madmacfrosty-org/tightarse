/**
 * An account or a card, as the provider describes it.
 */

import { z } from "zod";
import { Currency } from "../money.js";
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
  /**
   * The account that superseded this one, where the provider has renamed it.
   *
   * Set by reconciliation, never by a person and never by the provider. The
   * row stays, its transactions stay, and they are read under the account
   * named here — so this is undone by clearing one field. See
   * `ledger/reconciliation.ts` for why the provider's id cannot be trusted as
   * an identity, and #199 for what it cost.
   */
  supersededBy: z.string().optional(),
  /** When `supersededBy` was established. */
  reconciledAt: z.string().datetime().optional(),
  /**
   * How many transactions the two accounts held in common.
   *
   * The evidence, kept so a person can judge the match rather than take it on
   * trust. Eighty-six is a card reissued; two is the threshold and worth a
   * second look. Present only when the link was worked out automatically.
   */
  reconciledShared: z.number().int().nonnegative().optional(),
  /**
   * Who joined these by hand, where nobody worked it out.
   *
   * The automatic match needs two transactions in common, which an account
   * renamed while dormant will never have. Present only when a person said so,
   * and the two fields are exclusive: one says a machine decided, the other
   * says a person did.
   */
  reconciledBy: z.string().optional(),
  /** Present only for accounts we have successfully fetched at least once. */
  lastSyncedAt: z.string().datetime().optional(),
});
export type Account = z.infer<typeof Account>;
