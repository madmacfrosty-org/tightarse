import { createHash } from "node:crypto";
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
 * A tenant is a HOUSEHOLD, not a person. Everyone in the household shares one
 * ledger, which is what makes internal transfer detection possible at all —
 * netting a movement between two family members' accounts requires seeing both
 * sides. Multi-tenant from commit one; retrofitting it is a table migration.
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
  /** Identifies the transaction. Not `transactionId` — that is unstable. */
  dedupKey: z.string().min(1),
  /** Copied from the transaction so the enrichment's key can be derived
   *  without reading it back. */
  timestamp: z.string().datetime(),
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

/**
 * The dedup key for a settled transaction, in priority order.
 *
 * `transaction_id` is deliberately absent: TrueLayer states it can change when
 * a transaction moves from pending to settled, so it can never be the identity.
 * `normalisedProviderTransactionId` exists precisely to survive that transition
 * and is populated on 100% of First Direct transactions — but it is optional in
 * the API, so the chain has to degrade.
 */
export function dedupKey(t: {
  normalisedProviderTransactionId?: string | undefined;
  providerTransactionId?: string | undefined;
  accountId: string;
  timestamp: string;
  amount: number;
  description: string;
}): string {
  if (t.normalisedProviderTransactionId) return `n:${t.normalisedProviderTransactionId}`;
  if (t.providerTransactionId) return `p:${t.providerTransactionId}`;
  // Last resort. Stable for a settled transaction, and the components are
  // exactly what a human would use to say "these are the same payment".
  const composite = [t.accountId, t.timestamp, String(t.amount), t.description].join("|");
  return `c:${createHash("sha256").update(composite).digest("hex").slice(0, 32)}`;
}

/** Month bucket for partitioning, e.g. "2026-08". */
export function monthOf(timestamp: string): string {
  return timestamp.slice(0, 7);
}

/**
 * DynamoDB key construction — the only place these strings are built.
 *
 * A tenant is a **household**, not a person. Internal transfer detection has to
 * see both sides of a movement between family members' accounts, which is only
 * possible if they share a partition space.
 *
 * Transactions partition by month because the dashboard's dominant read is
 * tenant-wide over a period. Enrichments share their transaction's partition,
 * so one query returns both and they are split by sort-key prefix in memory.
 * Per-account views come from gsi1.
 */
export const keys = {
  account: (tenantId: string, accountId: string) => ({
    pk: `T#${tenantId}`,
    sk: `ACCOUNT#${accountId}`,
  }),

  consent: (tenantId: string, consentId: string) => ({
    pk: `T#${tenantId}`,
    sk: `CONSENT#${consentId}`,
  }),

  transaction: (tenantId: string, timestamp: string, dedup: string) => ({
    pk: `T#${tenantId}#TX#${monthOf(timestamp)}`,
    sk: `TX#${timestamp}#${dedup}`,
  }),

  /** Same partition as the transaction it describes. */
  enrichment: (tenantId: string, timestamp: string, dedup: string) => ({
    pk: `T#${tenantId}#TX#${monthOf(timestamp)}`,
    sk: `EN#${timestamp}#${dedup}`,
  }),

  /**
   * Pending is a cache, not a ledger entry — pending transactions change
   * amount and can vanish. Ingest deletes and replaces the whole partition per
   * account each sync, with a TTL as backstop.
   */
  pending: (tenantId: string, accountId: string, timestamp: string, providerId: string) => ({
    pk: `T#${tenantId}#PEND#${accountId}`,
    sk: `${timestamp}#${providerId}`,
  }),

  /** gsi1: per-account history. */
  accountIndex: (tenantId: string, accountId: string, timestamp: string, dedup: string) => ({
    gsi1pk: `T#${tenantId}#ACC#${accountId}`,
    gsi1sk: `TX#${timestamp}#${dedup}`,
  }),

  /**
   * gsi2: the categoriser's backlog. Written when a transaction lands and
   * REMOVED when its enrichment is stored — the index is sparse, so it holds
   * exactly the outstanding work and nothing else.
   */
  toEnrichIndex: (tenantId: string, timestamp: string, dedup: string) => ({
    gsi2pk: `T#${tenantId}#TOENRICH`,
    gsi2sk: `TX#${timestamp}#${dedup}`,
  }),
} as const;
