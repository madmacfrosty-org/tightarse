/**
 * A transaction, in the household's own terms.
 *
 * Sign is normalised at the boundary: negative left the household, positive
 * arrived. The provider does not supply that — it reports each resource from that
 * resource's own point of view, so a card DEBIT is positive — and everything
 * downstream relies on it. Do not re-derive direction from an amount anywhere.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { Amount, Currency } from "../money.js";
import { TenantId } from "../household/member.js";

/**
 * NOT a field TrueLayer returns. Settled and pending transactions come from
 * two different endpoints (`/transactions` and `/transactions/pending`), so
 * status is determined by which call produced the row. Ingest sets it.
 */
export const TransactionStatus = z.enum(["pending", "settled"]);
export type TransactionStatus = z.infer<typeof TransactionStatus>;

/**
 * Direction of movement. Orthogonal to status — this is TrueLayer's
 * `transaction_type`, which is DEBIT/CREDIT and says nothing about settlement.
 *
 * Redundant with the sign of `amount`, which is authoritative. Kept because it
 * makes a raw row readable without inspecting a number, and because a
 * disagreement between the two is a useful signal that something upstream
 * changed.
 */
export const TransactionType = z.enum(["DEBIT", "CREDIT"]);
export type TransactionType = z.infer<typeof TransactionType>;

export const Transaction = z.object({
  tenantId: TenantId,
  accountId: z.string().min(1),
  /**
   * TrueLayer's `transaction_id`. Explicitly NOT stable: it can change when a
   * transaction moves from pending to settled. Never dedupe on this alone.
   */
  transactionId: z.string().min(1),
  /** The bank's own id, when it provides one. */
  providerTransactionId: z.string().optional(),
  /**
   * TrueLayer's normalised id — the intended bridge across the pending→settled
   * transition, and stable across credentials for the majority of providers.
   * Optional because banks are not obliged to supply the underlying data, so
   * dedup logic must degrade gracefully when it is absent.
   */
  normalisedProviderTransactionId: z.string().optional(),
  /** Booking date, ISO-8601. Sort key component — do not reformat. */
  timestamp: z.string().datetime(),
  amount: Amount,
  currency: Currency,
  description: z.string(),
  merchantName: z.string().optional(),
  status: TransactionStatus,
  transactionType: TransactionType,
  /**
   * Account balance after this transaction, in minor units.
   *
   * TrueLayer reports this as an object, `{currency, amount}`, not a scalar —
   * the transform unwraps it. Present on 100% of settled First Direct
   * transactions and absent from pending ones.
   */
  /**
   * The provider's own running balance, stored verbatim and currently read by
   * nothing. Note it is NOT normalised the way `amount` is: on a card this is
   * the issuer's view, so it rises as you spend. Anything that starts using it
   * has to account for that.
   */
  runningBalance: Amount.optional(),
  /** Bank-supplied category. Present on every sandbox transaction. */
  providerCategory: z.string().optional(),
  /**
   * TrueLayer's own enrichment: [primary, sub], e.g. ["Food & Dining", "Groceries"].
   * Best-effort, purchases and direct debits only, and entirely absent from the
   * sandbox — treat as a hint for the categoriser, never as truth.
   */
  providerClassification: z.array(z.string()).optional(),

  // --- base-currency conversion -------------------------------------------
  //
  // Present only when `currency` differs from the household's base currency.
  // The original amount above is never touched: it is what the bank said, and
  // the conversion is a derived view of it.
  //
  // Converted at ingest rather than at read, deliberately. Converting at query
  // time would mean last year's spending totals changing whenever the exchange
  // rate moves — historical figures have to be stable. The rate is pinned at
  // the transaction date and recorded, so a wrong rate is fixable by replaying
  // from raw rather than being baked in.

  /** Amount in the household's base currency, minor units. */
  baseAmount: Amount.optional(),
  baseCurrency: Currency.optional(),
  /** Units of base currency per unit of `currency`, as applied. */
  fxRate: z.number().positive().optional(),
  /** Date of the rate used — the transaction date, not the ingest date. */
  fxRateDate: z.string().optional(),
  /** Where the rate came from, so a disputed figure can be traced. */
  fxSource: z.string().optional(),
});
export type Transaction = z.infer<typeof Transaction>;

/**
 * A transaction as it was recorded, rather than as it was received.
 *
 * `Transaction` is what a provider response becomes at the boundary. It has no
 * identity of its own: `dedupKey` is a *function* over its content, computed
 * when the row is written. So a transaction read back carries two things a
 * freshly mapped one cannot — the identity it was stored under, and when we
 * first saw it.
 *
 * Only those two. The stored row also carries `sourceObject`, the key of the
 * raw S3 object it came from, and it is not here: nothing in the domain reads
 * it, and parsing drops what is not declared. It remains on the row, where it
 * turns "this number looks wrong" into a lookup, and `FIRST_OBSERVATION` still
 * protects it from being rewritten. A port says what a component may see, and
 * the answer for a debugging pointer is nothing.
 *
 * The distinction is not pedantry. `dedupKey` is what every categorisation
 * joins on, and `Transaction` does not have it. Typing a read as `Transaction`
 * would parse the stored row, strip the key, and leave every category silently
 * unmatched — which is precisely the failure #41 describes, where a green build
 * returns confidently wrong answers.
 *
 * Pending rows are deliberately NOT this type. They are a transient cache that
 * never becomes a ledger row, and `pendingItem` writes no `dedupKey` at all.
 */
export const RecordedTransaction = Transaction.extend({
  /** The identity the row was stored under. See `dedupKey`. */
  dedupKey: z.string().min(1),
  /**
   * When we FIRST saw it — not when it happened, and not part of what it says.
   *
   * Load-bearing, not provenance: `providerCategorisation` uses it as the
   * version of the provider's set, because the provider publishes no taxonomy
   * version and an observation stamp is the honest substitute. `LedgerRow` did
   * not declare it, so the cast into `resolve` was passing along a field the
   * type said was absent and the code was reading anyway.
   */
  ingestedAt: z.string(),
});
export type RecordedTransaction = z.infer<typeof RecordedTransaction>;

/**
 * Identity of a settled transaction.
 *
 * Measured against 9,653 real First Direct transactions, because two plausible
 * schemes both turned out to merge distinct payments:
 *
 *   normalised_provider_transaction_id   191 card transactions -> 160 ids
 *   timestamp + amount + description     9,168 account rows    -> 9,028 keys
 *
 * The first collides because the provider reuses ids across card transactions
 * with entirely different amounts. The second collides because people really do
 * buy the same thing twice on the same day. Either alone would have silently
 * merged real transactions — money quietly disappearing from the ledger.
 *
 * Only the provider identifier COMBINED with the content is unique across every
 * account and the card: 9,653 transactions, 9,653 keys.
 *
 * Including the amount is safe here specifically because pending rows are a
 * separate transient cache that never becomes a ledger row. Nothing ever has to
 * bridge a pending transaction to its settled self, so an amount changing on
 * settlement cannot break identity.
 *
 * The prefix records which identifier was available, so a row shows how much
 * confidence its identity carries.
 */
export function dedupKey(t: {
  normalisedProviderTransactionId?: string | undefined;
  providerTransactionId?: string | undefined;
  accountId: string;
  timestamp: string;
  amount: number;
  description: string;
}): string {
  const content = [
    t.accountId,
    t.timestamp,
    String(t.amount),
    t.description,
  ].join("|");
  const digest = (input: string): string =>
    createHash("sha256").update(input).digest("hex").slice(0, 32);

  if (t.normalisedProviderTransactionId) {
    return `n:${digest(`${t.normalisedProviderTransactionId}|${content}`)}`;
  }
  if (t.providerTransactionId) {
    return `p:${digest(`${t.providerTransactionId}|${content}`)}`;
  }
  // No provider identifier at all. Two transactions identical in account, time,
  // amount and description are then genuinely indistinguishable and will merge.
  // First Direct always supplies ids, so this path is theoretical — but a
  // provider that does not would need an additional discriminator.
  return `c:${digest(content)}`;
}

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
