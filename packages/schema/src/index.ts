import { z } from "zod";

/**
 * Single source of truth for every item shape in Tightarse.
 *
 * CDK, the ingest Lambda, the API, the agents and the web app all import from
 * here. If a shape is not defined in this file it does not belong in the table.
 */

/** ISO-4217, e.g. GBP. */
export const Currency = z.string().length(3).regex(/^[A-Z]{3}$/);

/** Minor units (pence). Never use floats for money. */
export const Amount = z.number().int();

export const TenantId = z.string().min(1).max(64);

/**
 * Multi-tenant from commit one. The family are simply the first tenants —
 * retrofitting this later is a table migration.
 */
export const Account = z.object({
  tenantId: TenantId,
  accountId: z.string().min(1),
  provider: z.literal("truelayer"),
  /** Provider's own identifier, opaque to us. */
  providerAccountId: z.string().min(1),
  displayName: z.string(),
  institutionName: z.string(),
  currency: Currency,
  /** Present only for accounts we have successfully fetched at least once. */
  lastSyncedAt: z.string().datetime().optional(),
});
export type Account = z.infer<typeof Account>;

/**
 * NOT a field TrueLayer returns. Settled and pending transactions come from
 * two different endpoints (`/transactions` and `/transactions/pending`), so
 * status is determined by which call produced the row. Ingest sets it.
 */
export const TransactionStatus = z.enum(["pending", "settled"]);
export type TransactionStatus = z.infer<typeof TransactionStatus>;

/** Direction of movement. Orthogonal to status — this is TrueLayer's
 *  `transaction_type`, which is DEBIT/CREDIT and says nothing about settlement. */
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
  /** Account balance after this transaction, where the bank reports it. */
  runningBalance: Amount.optional(),
  /** Bank-supplied category. Present on every sandbox transaction. */
  providerCategory: z.string().optional(),
  /**
   * TrueLayer's own enrichment: [primary, sub], e.g. ["Food & Dining", "Groceries"].
   * Best-effort, purchases and direct debits only, and entirely absent from the
   * sandbox — treat as a hint for the categoriser, never as truth.
   */
  providerClassification: z.array(z.string()).optional(),
});
export type Transaction = z.infer<typeof Transaction>;

/**
 * Agent output lives in its own item type and never mutates a Transaction.
 * The ledger is deterministic; derived data is separate and re-computable.
 */
export const TransactionEnrichment = z.object({
  tenantId: TenantId,
  transactionId: z.string().min(1),
  category: z.string(),
  confidence: z.number().min(0).max(1),
  /** Which agent/model produced this, so it can be invalidated wholesale. */
  producedBy: z.string(),
  producedAt: z.string().datetime(),
});
export type TransactionEnrichment = z.infer<typeof TransactionEnrichment>;

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

/** DynamoDB key construction — the only place these strings are built. */
export const keys = {
  account: (tenantId: string, accountId: string) => ({
    pk: `TENANT#${tenantId}`,
    sk: `ACCOUNT#${accountId}`,
  }),
  transaction: (tenantId: string, accountId: string, timestamp: string, transactionId: string) => ({
    pk: `TENANT#${tenantId}#ACCOUNT#${accountId}`,
    sk: `TXN#${timestamp}#${transactionId}`,
  }),
  enrichment: (tenantId: string, transactionId: string) => ({
    pk: `TENANT#${tenantId}`,
    sk: `ENRICH#${transactionId}`,
  }),
  consent: (tenantId: string, consentId: string) => ({
    pk: `TENANT#${tenantId}`,
    sk: `CONSENT#${consentId}`,
  }),
} as const;
