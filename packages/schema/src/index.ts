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

/**
 * Convert a provider amount to integer minor units.
 *
 * TrueLayer returns amounts as JSON numbers in major units — pounds with
 * decimals, not pence. That makes this the single most dangerous conversion in
 * the codebase: `12.99 * 100` is `1298.9999999999998` in IEEE 754, so dropping
 * the rounding loses a penny on roughly a quarter of real transactions, in the
 * direction that under-reports spending.
 *
 * Math.round is exact for the range banks produce: at most two decimal places,
 * far inside 2^53 once scaled. Do not "simplify" this to a truncation.
 *
 * Sign is preserved and is authoritative — TrueLayer signs debits negative and
 * credits positive, consistently across the 9,707 transactions measured.
 */
export function toMinorUnits(majorUnits: number): number {
  if (!Number.isFinite(majorUnits)) {
    throw new Error(`Amount is not a finite number: ${majorUnits}`);
  }
  return Math.round(majorUnits * 100);
}

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

/** Row kind, encoded in the sort key after the timestamp. */
export const RowKind = { transaction: "TX", enrichment: "EN" } as const;
export type RowKind = (typeof RowKind)[keyof typeof RowKind];

/**
 * DynamoDB key construction — the only place these strings are built.
 *
 * A tenant is a **household**, not a person. Internal transfer detection has to
 * see both sides of a movement between family members' accounts, which is only
 * possible if they share a partition space.
 *
 * Transactions and enrichments share one partition per tenant, with the row
 * kind placed AFTER the timestamp in the sort key. That ordering is the whole
 * trick: a single `between` on the sort key returns transactions and their
 * enrichments together, interleaved and adjacent, for any date range.
 *
 * An earlier design bucketed the partition by month. That was wrong — DynamoDB
 * requires an exact partition-key match on every query, so a twelve-month view
 * became twelve queries. Bucketing exists to relieve partition size and write
 * throughput, and neither binds here: there is no item-collection size limit
 * without an LSI, and this table takes on the order of ten writes a day.
 *
 * Revisit if a single tenant partition passes a few hundred thousand items, or
 * if writes approach 1,000 WCU against one partition key.
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
    pk: `T#${tenantId}#TX`,
    sk: `${timestamp}#${RowKind.transaction}#${dedup}`,
  }),

  /** Same partition and timestamp as the transaction it describes, so the two
   *  land adjacent to each other in one query. */
  enrichment: (tenantId: string, timestamp: string, dedup: string) => ({
    pk: `T#${tenantId}#TX`,
    sk: `${timestamp}#${RowKind.enrichment}#${dedup}`,
  }),

  /** Sort-key bounds for a date range, inclusive of `from` and exclusive of
   *  `to`. Returns both transactions and enrichments. */
  rangeBounds: (from: string, to: string) => ({ from, to }),

  /**
   * Pending is a cache, not a ledger entry — pending transactions change
   * amount and can vanish. Ingest deletes and replaces the whole partition per
   * account each sync, with a TTL as backstop.
   */
  pending: (tenantId: string, accountId: string, timestamp: string, providerId: string) => ({
    pk: `T#${tenantId}#PEND#${accountId}`,
    sk: `${timestamp}#${providerId}`,
  }),

  /** gsi1: per-account history, same sort-key layout as the base table. */
  accountIndex: (tenantId: string, accountId: string, timestamp: string, dedup: string) => ({
    gsi1pk: `T#${tenantId}#ACC#${accountId}`,
    gsi1sk: `${timestamp}#${RowKind.transaction}#${dedup}`,
  }),

  /**
   * gsi2: the categoriser's backlog. Written when a transaction lands and
   * REMOVED when its enrichment is stored — the index is sparse, so it holds
   * exactly the outstanding work and nothing else.
   */
  toEnrichIndex: (tenantId: string, timestamp: string, dedup: string) => ({
    gsi2pk: `T#${tenantId}#TOENRICH`,
    gsi2sk: `${timestamp}#${RowKind.transaction}#${dedup}`,
  }),
} as const;

// ---------------------------------------------------------------- raw objects

/**
 * Which dataset a provider response belongs to.
 *
 * "dataset" collapses what used to be two segments — layer and endpoint. They
 * were the same idea: this identifies the shape, and the namespace prefix
 * carries where it came from. Curated datasets (`ledger.*`) conform to our
 * schema rather than a provider's, which is why "endpoint" was the wrong word.
 */
export function datasetForEndpoint(endpoint: string): string {
  const p = endpoint
    .replace(/^\/data\/v1\//, "")
    .replace(/\/[0-9a-f]{32}/g, "/{id}");

  const map: Record<string, string> = {
    "me": "truelayer.me",
    "info": "truelayer.info",
    "accounts": "truelayer.accounts",
    "accounts/{id}": "truelayer.account",
    "accounts/{id}/balance": "truelayer.balance",
    "accounts/{id}/transactions": "truelayer.transactions",
    "accounts/{id}/transactions/pending": "truelayer.transactions_pending",
    "accounts/{id}/direct_debits": "truelayer.direct_debits",
    "accounts/{id}/standing_orders": "truelayer.standing_orders",
    "cards": "truelayer.cards",
    "cards/{id}": "truelayer.card",
    "cards/{id}/balance": "truelayer.card_balance",
    "cards/{id}/transactions": "truelayer.card_transactions",
    "cards/{id}/transactions/pending": "truelayer.card_transactions_pending",
  };

  const dataset = map[p];
  if (!dataset) throw new Error(`No dataset mapping for endpoint ${endpoint}`);
  return dataset;
}

/**
 * S3 key for a raw provider response.
 *
 *   tenant=<t>/dataset=<source>.<name>/account=<a>/<compactIso>-<hash>.json.gz
 *
 * Tenant leads so that erasure is a single prefix delete covering every
 * dataset and layer, and so one IAM condition can scope a principal to one
 * household. There is deliberately no date partition: the fetch date is not
 * the transaction date, the distinction invites misreading, and at this volume
 * it bought nothing — the filename carries the timestamp and S3 lists keys
 * lexicographically, so ordering is preserved anyway.
 *
 * The hash is of the response body, so re-uploading identical content lands on
 * the same key rather than accumulating duplicates.
 */
export function rawObjectKey(args: {
  tenantId: string;
  dataset: string;
  accountId?: string | undefined;
  fetchedAt: string;
  contentHash: string;
}): string {
  const compact = args.fetchedAt.replace(/[-:]/g, "").replace(/\.\d+/, "");
  const parts = [`tenant=${args.tenantId}`, `dataset=${args.dataset}`];
  if (args.accountId) parts.push(`account=${args.accountId}`);
  parts.push(`${compact}-${args.contentHash.slice(0, 12)}.json.gz`);
  return parts.join("/");
}
