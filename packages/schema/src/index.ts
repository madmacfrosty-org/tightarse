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
 * ISO 4217 minor-unit exponents that are not 2.
 *
 * The overwhelming majority of currencies use 2 decimal places, so this lists
 * only the exceptions. Getting it wrong is not a rounding error: treating JPY
 * as 2-decimal overstates every amount a hundredfold.
 */
const MINOR_UNIT_EXPONENTS: Record<string, number> = {
  // Zero-decimal
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // Three-decimal
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  // Four-decimal
  CLF: 4,
};

/** How many minor units make one major unit of this currency. */
export function minorUnitExponent(currency: string): number {
  return MINOR_UNIT_EXPONENTS[currency.toUpperCase()] ?? 2;
}

/**
 * Convert a provider amount to integer minor units.
 *
 * TrueLayer returns amounts as JSON numbers in major units — pounds with
 * decimals, not pence. That makes this the single most dangerous conversion in
 * the codebase: `12.99 * 100` is `1298.9999999999998` in IEEE 754, so dropping
 * the rounding loses a penny on roughly a quarter of real transactions, in the
 * direction that under-reports spending.
 *
 * Math.round is exact for the range banks produce: at most the currency's
 * declared precision, far inside 2^53 once scaled. Do not "simplify" this to a
 * truncation.
 *
 * The currency is required because the scale factor is not always 100. JPY has
 * no minor unit at all and KWD has three, so a hardcoded multiplier is wrong by
 * a factor of a hundred or ten respectively.
 *
 * Sign is preserved and is authoritative — TrueLayer signs debits negative and
 * credits positive, consistently across the 9,707 transactions measured.
 */
export function toMinorUnits(majorUnits: number, currency: string): number {
  if (!Number.isFinite(majorUnits)) {
    throw new Error(`Amount is not a finite number: ${majorUnits}`);
  }
  const scale = 10 ** minorUnitExponent(currency);
  return Math.round(majorUnits * scale);
}

/**
 * Guard against silently adding yen to pounds.
 *
 * Any aggregation over a mixed-currency set must convert first. Summing raw
 * `amount` across currencies produces a plausible-looking number that is simply
 * wrong, which is the worst kind of bug in a finance application — so this
 * throws rather than returning something defensible.
 */
export function assertSingleCurrency(items: ReadonlyArray<{ currency: string }>): string | null {
  if (items.length === 0) return null;
  const first = items[0]!.currency;
  const other = items.find((i) => i.currency !== first);
  if (other) {
    throw new Error(
      `Cannot aggregate across currencies (${first} and ${other.currency}) — convert to a base currency first`,
    );
  }
  return first;
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
  const content = [t.accountId, t.timestamp, String(t.amount), t.description].join("|");
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
export const EnrichmentMode = z.enum(["off", "rules", "model"]);
export type EnrichmentMode = z.infer<typeof EnrichmentMode>;

export const TenantSettings = z.object({
  tenantId: TenantId,
  enrichment: EnrichmentMode,
  baseCurrency: Currency.default("GBP"),
  updatedAt: z.string().datetime(),
});
export type TenantSettings = z.infer<typeof TenantSettings>;

/**
 * Which household a person belongs to.
 *
 * Created by an administrator, never by the person signing in. With federated
 * login there is no password to gate on — anyone with a Google account could
 * reach the sign-in screen — so this record is what decides whether a verified
 * identity gets a household claim at all.
 *
 * No membership record means no claim, and no claim means the API refuses. It
 * fails closed by construction rather than by a check someone might remove.
 */
/**
 * A household's own categorisation rule.
 *
 * Kept in the table rather than the repository, and that is the entire point.
 * The generic rules in `agents/categoriser` are national chains that apply to
 * anyone. A household's real statement is not: its highest-volume descriptions
 * are family names, an employer, a named individual paid regularly, and its own
 * sort codes and account numbers. Committing rules for those to a public repo
 * would publish exactly what the repo is careful never to hold.
 *
 * So personal rules are DATA. They live beside the ledger they describe, under
 * the same encryption and the same access control.
 */
export const CustomRule = z.object({
  /** Case-insensitive regular expression matched against the description. */
  pattern: z.string().min(2),
  category: z.string().min(1),
  /** Optional reminder of why this exists. */
  note: z.string().optional(),
  addedAt: z.string().datetime(),
});
export type CustomRule = z.infer<typeof CustomRule>;

export const Member = z.object({
  /** Verified email from the identity provider, lowercased. */
  email: z.string().email(),
  tenantId: TenantId,
  addedAt: z.string().datetime(),
});
export type Member = z.infer<typeof Member>;

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
 *
 * There is deliberately no index for "transactions awaiting categorisation".
 * That was a sparse gsi2 carrying a marker on the transaction row, removed when
 * enrichment landed — but a plain put replaces the whole row, so replaying a
 * raw object re-added the marker and re-queued work that was already done.
 * Since replay is the entire point of the landing zone, that made the bug
 * routine rather than exotic. The backlog is now derived: read a range, which
 * returns transactions and enrichments together anyway, and diff in memory.
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

  settings: (tenantId: string) => ({
    pk: `T#${tenantId}`,
    sk: "SETTINGS",
  }),

  /**
   * Keyed by email rather than by tenant, because the lookup runs the other
   * way: a token is being minted for a person and we need their household.
   * A direct GetItem, no index, no scan.
   */
  customRules: (tenantId: string) => ({ pk: `T#${tenantId}`, sk: "RULES" }),
  member: (email: string) => ({
    pk: `MEMBER#${email.trim().toLowerCase()}`,
    sk: "MEMBER",
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

/**
 * Inverse of {@link rawObjectKey}.
 *
 * The transform is handed a key by an S3 event and has to know which household
 * and dataset it is looking at before it can parse the body. Reading it back
 * out of the key keeps that decision in one place rather than duplicating the
 * convention in every consumer.
 */
export function parseRawKey(key: string): {
  tenantId: string;
  dataset: string;
  accountId?: string;
  filename: string;
} {
  const segments = key.split("/");
  const get = (prefix: string): string | undefined => {
    const seg = segments.find((s) => s.startsWith(`${prefix}=`));
    return seg?.slice(prefix.length + 1);
  };

  const tenantId = get("tenant");
  const dataset = get("dataset");
  if (!tenantId || !dataset) {
    throw new Error(`Not a raw object key: ${key}`);
  }

  const accountId = get("account");
  return {
    tenantId,
    dataset,
    ...(accountId ? { accountId } : {}),
    filename: segments[segments.length - 1] ?? "",
  };
}
