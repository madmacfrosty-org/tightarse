import {
  keys,
  dedupKey,
  RowKind,
  type Account,
  type Consent,
  type Transaction,
  type TransactionEnrichment,
  type RuleSet,
  type Categorisation,
} from "@tightarse/schema";

/**
 * Item construction. Pure — no I/O, no SDK — so the shape of every row is
 * testable without a database.
 *
 * Key strings are never built here; they come from @tightarse/schema, which is
 * the single place they exist.
 */

export interface TransactionItem extends Record<string, unknown> {
  pk: string;
  sk: string;
  gsi1pk: string;
  gsi1sk: string;
}

/**
 * A settled transaction, plus the index attributes.
 *
 * `sourceObject` records which raw S3 object produced this row. It costs about
 * 100 bytes an item and is what turns "this number looks wrong" into a lookup
 * rather than an investigation.
 *
 * No backlog marker is written. An earlier design put one here and removed it
 * when enrichment landed, but a plain put replaces the whole row — so replaying
 * a raw object silently re-queued already-categorised transactions. The backlog
 * is derived instead, by diffing a range query that returns both kinds anyway.
 */
export function transactionItem(
  txn: Transaction,
  opts: { sourceObject?: string; ingestedAt?: string } = {},
): TransactionItem {
  const dedup = dedupKey(txn);
  const { pk, sk } = keys.transaction(txn.tenantId, txn.timestamp, dedup);
  const { gsi1pk, gsi1sk } = keys.accountIndex(txn.tenantId, txn.accountId, txn.timestamp, dedup);

  return {
    pk,
    sk,
    gsi1pk,
    gsi1sk,
    kind: RowKind.transaction,
    dedupKey: dedup,
    ...txn,
    ...(opts.sourceObject ? { sourceObject: opts.sourceObject } : {}),
    ingestedAt: opts.ingestedAt ?? new Date().toISOString(),
  };
}

export function enrichmentItem(e: TransactionEnrichment): Record<string, unknown> {
  const { pk, sk } = keys.enrichment(e.tenantId, e.timestamp, e.dedupKey);
  return { pk, sk, kind: RowKind.enrichment, ...e };
}

/**
 * A pending transaction.
 *
 * Deliberately not keyed on the dedup chain: pending rows are a cache, replaced
 * wholesale each sync because they change amount and can vanish entirely. The
 * TTL is a backstop for the case where a sync stops running — stale pending
 * rows should disappear rather than linger looking authoritative.
 */
export function pendingItem(
  txn: Transaction,
  opts: { ttlSeconds: number; now?: Date },
): Record<string, unknown> {
  const providerId = txn.providerTransactionId ?? txn.transactionId;
  const { pk, sk } = keys.pending(txn.tenantId, txn.accountId, txn.timestamp, providerId);
  const now = opts.now ?? new Date();
  return {
    pk,
    sk,
    kind: "PEND",
    ...txn,
    status: "pending",
    expiresAt: Math.floor(now.getTime() / 1000) + opts.ttlSeconds,
  };
}

/**
 * Sync and reconciliation state for one account — not a display model. The
 * product is a single aggregated ledger, so account names are never rendered
 * beside transactions, and bank details deliberately do not appear here.
 */
export function accountItem(
  a: Account,
  balances: { current?: number; available?: number } = {},
): Record<string, unknown> {
  const { pk, sk } = keys.account(a.tenantId, a.accountId);
  return {
    pk,
    sk,
    kind: "ACCOUNT",
    ...a,
    ...(balances.current !== undefined ? { currentBalance: balances.current } : {}),
    ...(balances.available !== undefined ? { availableBalance: balances.available } : {}),
  };
}

export function consentItem(c: Consent): Record<string, unknown> {
  const { pk, sk } = keys.consent(c.tenantId, c.consentId);
  return { pk, sk, kind: "CONSENT", ...c };
}


/**
 * The two rows a rule set version becomes: the immutable record, and the current
 * pointer that is a copy of it.
 *
 * Built as a pair, in one place, because the duplication is the whole point of
 * the design and splitting it across two call sites is how the copies come to
 * disagree. The caller writes them in a single transaction.
 */
export function ruleSetItems(
  tenantId: string,
  set: RuleSet,
): { current: Record<string, unknown>; version: Record<string, unknown> } {
  const body = { ...set, tenantId, kind: "RULESET" };
  return {
    current: { ...keys.ruleSet(tenantId, set.setId), ...body },
    version: { ...keys.ruleSetVersion(tenantId, set.setId, set.version), ...body },
  };
}

/**
 * The two rows a categorisation becomes.
 *
 * The current row is keyed by SET rather than by version, so a batch read
 * returns one row per set however deep the history — and so two sets cannot
 * overwrite each other, which they do if the set id is left out of the key.
 */
export function categorisationItems(
  tenantId: string,
  c: Categorisation,
): { current: Record<string, unknown>; version: Record<string, unknown> } {
  const body = { ...c, tenantId, kind: RowKind.categorisation };
  return {
    current: { ...keys.categorisation(tenantId, c.timestamp, c.dedupKey, c.setId), ...body },
    version: { ...keys.categorisationVersion(tenantId, c.dedupKey, c.setId, c.version), ...body },
  };
}
