/**
 * Ports: what the application needs of a store, declared by the side that needs
 * it rather than by the side that provides it.
 *
 * These used to be `Pick<Ledger, "listRange" | "listAccounts">` at each call
 * site — a view onto the adapter rather than an interface the domain owns. The
 * difference matters: with a `Pick`, adding a method to the adapter silently
 * widens what every consumer may reach for, and nothing can fail to satisfy a
 * contract that is defined as "whatever that class happens to have".
 *
 * Two planes, and the line between them is the one this codebase already
 * enforces everywhere else:
 *
 * - **Data** is derived and rebuildable. A replay of the raw zone reproduced the
 *   whole transaction ledger identically, so anything here can be regenerated.
 * - **Control** is authored and irreplaceable. Nothing regenerates a household's
 *   own rules, its members, or a correction somebody made by hand.
 *
 * A bulk regeneration job depends only on data-plane ports, and therefore
 * *cannot* touch a rule set or a member — not because it was careful, but
 * because it holds no interface that offers it.
 *
 * Signatures here match the adapter's exactly, so adopting them changes no
 * behaviour. Improving them — parsing reads instead of returning untyped bags —
 * is a separate change, deliberately not mixed in with moving the boundary.
 */

import type {
  Account,
  BalanceReading,
  Categorisation,
  Consent,
  CustomRule,
  Member,
  RuleSet,
  TenantSettings,
  Transaction,
  TransactionEnrichment,
} from "@tightarse/schema";

/** A stored row, as the adapter currently returns it. */
export type Row = Record<string, unknown>;

/**
 * A date range, inclusive at both ends.
 *
 * Declared here rather than in the adapter, where it used to live. A range of
 * dates is domain vocabulary — the adapter's job is to satisfy a request for
 * one, not to define what one is. That it was defined in the persistence layer
 * is a small instance of the inversion this refactor exists to fix.
 */
export interface DateRange {
  readonly from: string;
  readonly to: string;
}

// ---------------------------------------------------------------- data plane

/**
 * The transaction record and its enrichments.
 *
 * `listRange` returns three kinds from one query because they share a partition
 * — that adjacency is deliberate and is what makes a batch read one call.
 */
export interface Transactions {
  listRange(
    tenantId: string,
    range: DateRange,
  ): Promise<{ transactions: Row[]; enrichments: Row[]; categorisations: Row[] }>;
  listAccountRange(tenantId: string, accountId: string, range: DateRange): Promise<Row[]>;
  putTransactions(
    txns: readonly Transaction[],
    opts?: { sourceObject?: string },
  ): Promise<{ written: number }>;
  listPending(tenantId: string, accountId: string): Promise<Row[]>;
  replacePending(
    tenantId: string,
    accountId: string,
    txns: readonly Transaction[],
  ): Promise<{ deleted: number; written: number }>;
}

/**
 * Enrichment, as it exists today.
 *
 * Being replaced by `Categorisations`: `listToEnrich` defines the backlog as
 * "has no enrichment row", which is a business rule living in the persistence
 * layer, and the categorisation design replaces it with staleness by rule set
 * version. Kept as its own port so what is going away is visible.
 */
export interface Enrichments {
  listToEnrich(tenantId: string, range: DateRange, limit?: number): Promise<Row[]>;
  putEnrichment(e: TransactionEnrichment): Promise<void>;
  deleteEnrichments(
    tenantId: string,
    range: DateRange,
    producedBy: string,
  ): Promise<{ deleted: number }>;
}

/** Categorisations. Current rows arrive via `Transactions.listRange`. */
export interface Categorisations {
  putCategorisation(tenantId: string, c: Categorisation): Promise<void>;
  listCategorisationHistory(tenantId: string, dedupKey: string): Promise<Row[]>;
}

export interface Accounts {
  listAccounts(tenantId: string): Promise<Row[]>;
  putAccount(account: Account): Promise<void>;
  putBalances(
    tenantId: string,
    accountId: string,
    balances: { current?: number; available?: number; currency?: string; isCard?: boolean },
  ): Promise<void>;
}

export interface Balances {
  putBalanceReading(reading: BalanceReading): Promise<void>;
  listBalanceReadings(tenantId: string, accountId: string): Promise<Row[]>;
  markBalanceReadingDirty(
    tenantId: string,
    accountId: string,
    asOf: string,
    fetchedAt: string,
    discrepancy: number,
  ): Promise<void>;
  clearBalanceReadingDirty(
    tenantId: string,
    accountId: string,
    asOf: string,
    fetchedAt: string,
  ): Promise<void>;
}

/**
 * The raw landing zone.
 *
 * Every provider response is written here before anything derives from it, and
 * the whole ledger has been rebuilt from it — a replay reproduced 9,790 rows
 * identically. It is the only thing in the system that is not reconstructible
 * from something else.
 *
 * **There is no delete.** The transform and the backfill previously held an
 * `S3Client`, which is the entire S3 API including `DeleteObject` and
 * `DeleteBucket`, in order to read one object. A port is a statement about what
 * a component may do, and nothing in this application may remove a raw object.
 * Lifecycle handles expiry, declared in infrastructure where it is reviewed.
 */
export interface RawObjects {
  /** The object's bytes. Callers decompress; storage does not interpret. */
  get(key: string): Promise<Uint8Array>;
  /**
   * Write a raw object.
   *
   * `contentType`, `contentEncoding` and `tags` are carried because the landing
   * zone is queried by tag and served to tools that respect encoding — they are
   * part of what a raw object IS here, not S3 trivia.
   */
  put(
    key: string,
    body: Uint8Array,
    opts?: {
      contentType?: string;
      contentEncoding?: string;
      tags?: Record<string, string>;
    },
  ): Promise<void>;
  /** Every key under a prefix, following pagination. */
  list(prefix: string): Promise<string[]>;
}

/**
 * Provider credentials and per-connection refresh tokens.
 *
 * Narrow deliberately: a refresh token is the one secret whose loss costs five
 * years of history that no amount of retrying gets back, because recovering it
 * means a fresh consent and a fresh 90-day window.
 */
export interface Secrets {
  get(name: string): Promise<string | undefined>;
  /** Create or overwrite. The distinction is the adapter's problem, not the caller's. */
  set(name: string, value: string): Promise<void>;
}

/**
 * Somewhere to say that something went wrong.
 *
 * One method, and no subscription management: an application that could
 * subscribe an address could also unsubscribe one, and delivery is not its
 * concern.
 */
export interface Notifications {
  publish(subject: string, message: string): Promise<void>;
}

// ------------------------------------------------------------- control plane

/**
 * Rule sets. Authored, versioned, and never regenerated.
 *
 * `putRuleSetVersion` writes the immutable record and the current pointer in one
 * transaction; a published version cannot be rewritten, because a
 * categorisation's provenance names it.
 */
export interface RuleSets {
  listRuleSets(tenantId: string): Promise<Row[]>;
  listRuleSetHistory(tenantId: string, setId: string): Promise<Row[]>;
  putRuleSetVersion(tenantId: string, set: RuleSet): Promise<void>;
  /** The single-item rules that predate versioned sets. Migrating away. */
  getCustomRules(tenantId: string): Promise<CustomRule[]>;
  putCustomRules(tenantId: string, rules: readonly CustomRule[]): Promise<void>;
}

/**
 * Who may see the household, and how it is configured.
 *
 * Nothing here is derivable from anything. Losing it means asking a person what
 * they had decided.
 */
export interface Household {
  getMemberTenant(email: string): Promise<string | null>;
  putMember(member: Member): Promise<void>;
  deleteMember(email: string): Promise<void>;
  listMembers(): Promise<Row[]>;
  getSettings(tenantId: string): Promise<TenantSettings | null>;
  putSettings(settings: TenantSettings): Promise<void>;
  listConsents(tenantId: string): Promise<Row[]>;
  putConsent(consent: Consent): Promise<void>;
}

// --------------------------------------------------------- consumer-shaped
//
// The ports above are organised by what they cover. These are shaped to one
// component's need, and several deliberately span the planes above or take a
// slice narrower than any of them. A port is a statement about what a component
// MAY do, so the right size is "what this one needs" rather than "what belongs
// together".

/**
 * One method, deliberately.
 *
 * The pre-token trigger turns a verified email into a household claim and needs
 * nothing else. Handing it the whole `Household` port would let a Lambda that
 * runs on every sign-in reach for member deletion — a port is a statement about
 * what a component MAY do, not only what it does.
 */
export interface MemberLookup {
  getMemberTenant(email: string): Promise<string | null>;
}

/**
 * What the read API needs, and nothing more.
 *
 * Narrower than `Transactions` and `Accounts` together, because the API reads
 * and never writes. Handed the full ports it could put a transaction, which is
 * not a capability an HTTP read path should hold.
 */
export interface LedgerReads {
  listRange(
    tenantId: string,
    range: DateRange,
  ): Promise<{ transactions: Row[]; enrichments: Row[]; categorisations: Row[] }>;
  listAccounts(tenantId: string): Promise<Row[]>;
}

/**
 * What the transform writes: the ledger rows a raw provider object becomes.
 *
 * Writes only. The transform derives rows from an immutable raw object and has
 * no reason to read the ledger back — and a component that cannot read cannot
 * accidentally make a write conditional on what it finds, which is how a
 * deterministic transform stops being deterministic.
 */
export interface LedgerWrites {
  putTransactions(
    txns: readonly Transaction[],
    opts?: { sourceObject?: string },
  ): Promise<{ written: number }>;
  replacePending(
    tenantId: string,
    accountId: string,
    txns: readonly Transaction[],
  ): Promise<{ deleted: number; written: number }>;
  putAccount(account: Account): Promise<void>;
  putBalances(
    tenantId: string,
    accountId: string,
    balances: { current?: number; available?: number; currency?: string; isCard?: boolean },
  ): Promise<void>;
  putBalanceReading(reading: BalanceReading): Promise<void>;
}

/**
 * What reconciliation may do: mark a reading as not adding up, and unmark it.
 *
 * Deliberately excludes writing readings. Reconciliation checks arithmetic; a
 * job that could also write the balances it checks against would be marking its
 * own homework.
 */
export interface ReconciliationMarks {
  markBalanceReadingDirty(
    tenantId: string,
    accountId: string,
    asOf: string,
    fetchedAt: string,
    discrepancy: number,
  ): Promise<void>;
  clearBalanceReadingDirty(
    tenantId: string,
    accountId: string,
    asOf: string,
    fetchedAt: string,
  ): Promise<void>;
}

/**
 * The categorisation batch: read the backlog, read the rules, write the result.
 *
 * `getSettings` is here because a household may turn enrichment off and a
 * schedule must respect it — the one control-plane read this data-plane job
 * legitimately needs.
 */
export interface CategoriserReads {
  listToEnrich(tenantId: string, range: DateRange, limit?: number): Promise<Row[]>;
  getCustomRules(tenantId: string): Promise<CustomRule[]>;
  putEnrichment(e: TransactionEnrichment): Promise<void>;
  getSettings(tenantId: string): Promise<TenantSettings | null>;
}
