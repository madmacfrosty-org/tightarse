/**
 * A balance, as the provider reported it at a moment in time.
 *
 * The primary balance data is the running total on each transaction; this is what
 * reconciliation checks it against, and the only balance a card has at all.
 */

import { z } from "zod";
import { Amount, Currency } from "../money.js";
import { TenantId } from "../household/member.js";

/**
 * One balance, as the provider reported it at a moment in time.
 *
 * Kept as a series rather than overwritten. The account row carries the latest
 * figure for display; these carry every figure with the time it was fetched,
 * because reconciliation needs two of them:
 *
 *   balance(later) - balance(earlier) == sum of amounts between
 *
 * That check works for cards, which carry no running balance on their
 * transactions at all — 0 of 278 in this ledger — so it is the only
 * reconciliation that covers every account.
 *
 * `balance` is in the household's convention, negative for money owed, matching
 * `amount` and `runningBalance`. The provider reports a card from the issuer's
 * point of view, so a card's is negated on the way in.
 */
export const BalanceReading = z.object({
  tenantId: TenantId,
  accountId: z.string().min(1),
  /** When we asked, from the raw envelope. Always present; our clock. */
  fetchedAt: z.string().datetime(),
  /**
   * `update_timestamp` exactly as the provider sent it, absent when it did not.
   *
   * Documented for the account balance as "Last update time of the data", and
   * on the card balance not documented at all — the OpenAPI definition gives it
   * a datatype and no meaning. So this is stored faithfully and interpreted
   * cautiously.
   *
   * Measured across 45 real responses: present on every one despite being
   * optional, and never later than our request. Accounts were fresh in all 22
   * cases; cards were stale in 8 of 23, the worst by 32 minutes. Card data is
   * evidently served from something refreshed earlier.
   */
  providerUpdatedAt: z.string().datetime().optional(),
  /**
   * When the balance was true, as far as we can tell: the provider's own
   * timestamp when it gave one, otherwise ours.
   *
   * The one field anything sorts or reconciles on, which is the point of having
   * it — `providerUpdatedAt` is optional and a reconciliation cannot be written
   * against a field that might not be there.
   */
  asOf: z.string().datetime(),
  balance: Amount,
  /** Funds available to spend. Absent for a card that does not report one. */
  available: Amount.optional(),
  currency: Currency,
  /**
   * Set when this reading could not be reconciled against the one before it.
   *
   * The number is kept and marked rather than hidden or corrected: a synthetic
   * transaction that makes the arithmetic work is a healthy-looking number over
   * missing data. Anything derived from a dirty reading is dirty too.
   */
  dirty: z.boolean().optional(),
  /** How far off the reconciliation was, in minor units. Present when dirty. */
  discrepancy: Amount.optional(),
});
export type BalanceReading = z.infer<typeof BalanceReading>;

/**
 * Categorisation shapes. See docs/design/categorisation.md for why the model
 * looks like this; the short version is that rules are values in versioned sets,
 * a categorisation is versioned so a transaction has a history, and nothing
 * authored ever lives on a transaction row.
 */
