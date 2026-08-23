/**
 * DynamoDB keys and row kinds.
 *
 * These lived in `@tightarse/domain` alongside the domain shapes, which meant
 * every package that wanted a `Transaction` type also learned what a partition
 * key is. A partition key is not a fact about a household's finances; it is a
 * fact about how one store happens to lay them out.
 *
 * They belong here, in the adapter, and nothing outside it has ever used them —
 * checked before moving, across every service, agent and the web app.
 *
 * The single most important property is unchanged: key strings are built in
 * exactly one place. A transaction's identity is content-addressed, so a second
 * implementation that disagreed by a character would orphan every reference to
 * every row it wrote.
 */

export const RowKind = {
  /**
   * Sorts before TX within a timestamp, so a categorisation arrives in
   * the same range query the API and the categoriser already make for
   * transactions. No new access pattern, no second read.
   */
  categorisation: "CAT",
  transaction: "TX",
} as const;
export type RowKind = (typeof RowKind)[keyof typeof RowKind];

/**
 * DynamoDB key construction — the only place these strings are built.
 *
 * A tenant is a **household**, not a person. Internal transfer detection has to
 * see both sides of a movement between family members' accounts, which is only
 * possible if they share a partition space.
 *
 * Transactions and their categorisations share one partition per tenant, with the row
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

  /**
   * The current version of a rule set.
   *
   * `begins_with("RULESET#")` returns exactly the sets a fold run needs — no
   * history to read and discard. The row carries its `version` as an attribute
   * and is overwritten in place; the immutable versioned copy is written
   * alongside it by `ruleSetVersion`, in the same transaction, so the two cannot
   * diverge.
   */
  /**
   * A category, keyed by its stable id rather than its label.
   *
   * The whole point of the entity: renaming a category is a one-field edit
   * rather than a rewrite of every row that references it.
   */
  category: (tenantId: string, id: string) => ({
    pk: `T#${tenantId}`,
    sk: `CATEGORY#${id}`,
  }),

  ruleSet: (tenantId: string, setId: string) => ({
    pk: `T#${tenantId}`,
    sk: `RULESET#${setId}`,
  }),

  /**
   * One immutable version of a rule set. The record; the current row above is
   * derived from it.
   *
   * Its own partition, so accumulating history never enlarges the query that
   * fetches the current sets. Zero-padded because these are compared as numbers:
   * lexically "10" precedes "9".
   */
  ruleSetVersion: (tenantId: string, setId: string, version: number) => ({
    pk: `T#${tenantId}#RULESETH`,
    sk: `${setId}#${String(version).padStart(6, "0")}`,
  }),

  /**
   * A transaction's current categorisation from one rule set.
   *
   * Keyed by SET, not by version. One row per set per transaction, overwritten in
   * place, carrying its `version` as an attribute — so a batch read returns
   * exactly one row per set however much history has accumulated, and the skip
   * check is "does this row's setVersion match the set's" without reading
   * anything else.
   *
   * The set id is load-bearing rather than decorative: without it two sets both
   * at version 1 collide, and the household set silently overwrites the built-in
   * one. Per-set rows are also what make selective re-firing possible — a set
   * that has not changed does not need re-folding.
   *
   * `CAT` sorts before `TX` within a timestamp, so these arrive in the
   * same range query the API and the categoriser already make.
   */
  categorisation: (tenantId: string, timestamp: string, dedup: string, setId: string) => ({
    pk: `T#${tenantId}#TX`,
    sk: `${timestamp}#${RowKind.categorisation}#${dedup}#${setId}`,
  }),

  /**
   * One immutable version of that categorisation. The history.
   *
   * Its own partition per transaction, because the dominant read is a batch of
   * transactions with their current categorisations, and history there would
   * make that query grow with churn rather than with transactions. This is
   * fetched only when somebody asks why a category changed.
   */
  categorisationVersion: (tenantId: string, dedup: string, setId: string, version: number) => ({
    pk: `T#${tenantId}#CATH#${dedup}`,
    sk: `${setId}#${String(version).padStart(6, "0")}`,
  }),

  /**
   * One row per balance fetch, newest last.
   *
   * Its own partition per account, so reading a series is one query and cannot
   * collide with the account row it describes.
   */
  /**
   * One row per balance fetch, ordered by when the balance was true.
   *
   * Composite rather than `asOf` alone: two fetches can legitimately return the
   * same provider timestamp — which is exactly what card caching does, measured
   * at up to 32 minutes — and keying on it would make the second write
   * overwrite the first, losing the fact that we asked twice. Keying on
   * `fetchedAt` alone would sort by when we asked rather than by when the
   * balance was true, which is the wrong order for reconciliation.
   *
   * Both halves are deterministic, so re-transforming the same raw object still
   * converges. Same shape as the transaction sort key.
   */
  balanceReading: (tenantId: string, accountId: string, asOf: string, fetchedAt: string) => ({
    pk: `T#${tenantId}#BAL#${accountId}`,
    sk: `${asOf}#${fetchedAt}`,
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

  /** gsi1: per-account history, same sort-key layout as the base table. */
  accountIndex: (tenantId: string, accountId: string, timestamp: string, dedup: string) => ({
    gsi1pk: `T#${tenantId}#ACC#${accountId}`,
    gsi1sk: `${timestamp}#${RowKind.transaction}#${dedup}`,
  }),

} as const;
