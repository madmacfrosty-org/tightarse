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

export const TransactionStatus = z.enum(["pending", "settled"]);
export type TransactionStatus = z.infer<typeof TransactionStatus>;

export const Transaction = z.object({
  tenantId: TenantId,
  accountId: z.string().min(1),
  /**
   * Provider transaction id. Note: a transaction's id can change when it moves
   * from pending to settled, so ingest must upsert on a stable composite key
   * rather than trusting this alone. See services/ingest.
   */
  transactionId: z.string().min(1),
  /** Booking date, ISO-8601. Sort key component — do not reformat. */
  timestamp: z.string().datetime(),
  amount: Amount,
  currency: Currency,
  description: z.string(),
  merchantName: z.string().optional(),
  status: TransactionStatus,
  /** Category assigned by the provider, if any. Not our categorisation. */
  providerCategory: z.string().optional(),
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
