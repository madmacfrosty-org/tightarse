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
  /** Balances are optional: the accounts list carries none, and a later balance
   *  fetch fills them in without disturbing the identity fields. */
  putAccount(account: Account, balances?: { current?: number; available?: number }): Promise<void>;
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
 * Every row in the table.
 *
 * A deliberately blunt capability, and its own port so that bluntness is
 * visible. Reconciliation and the replay comparison both need the whole ledger
 * at once — grouping by account in memory is fewer calls than a query per
 * account per kind at this size — but "read everything" is not something most
 * components should be able to ask for.
 *
 * Read-only, and no filtering: a scan that could be narrowed would invite
 * narrowing it, and a comparison against a fraction of the ledger reports a
 * confident match.
 */
export interface TableRows {
  scanAll(): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>>;
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
  /**
   * Create or overwrite. The distinction is the adapter's problem, not the
   * caller's — code storing a refreshed token does not know whether this
   * connection has been stored before.
   *
   * `description` and `tags` exist because a connection secret is created once
   * and then read by people looking at a console; an untagged, undescribed secret
   * holding five years of history access is worse than an inconvenience.
   */
  set(
    name: string,
    value: string,
    opts?: { description?: string; tags?: Record<string, string> },
  ): Promise<void>;
  /**
   * Names under a prefix, following pagination.
   *
   * Names only. Returning values would mean fetching every secret to answer
   * "which connections exist", and the caller decides which it actually needs.
   */
  list(prefix: string): Promise<string[]>;
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
  /** Balances are optional: the accounts list carries none, and a later balance
   *  fetch fills them in without disturbing the identity fields. */
  putAccount(account: Account, balances?: { current?: number; available?: number }): Promise<void>;
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

// ------------------------------------------------------------------- inbound
//
// Everything above is driven: interfaces the application calls outward, to a
// store, a bucket, a topic. What follows is the other side of the hexagon — what
// the application offers inward, to whatever drives it.
//
// It was missing, and its absence had a cost. The four operations below already
// have three drivers: the Lambda entry point, the local HTTP server and the
// report CLI. Undeclared, each reached in at whatever depth suited it — the CLI
// bypassed the use cases entirely and called the aggregation directly, with its
// own casts. And because the functions had no declared return type, what the API
// actually promised was inferred from whatever the aggregation happened to
// return, so a change in the shape of a total could reach a client without
// failing a build.
//
// The types here are domain vocabulary, not wire format. `@tightarse/api-contract`
// is the HTTP adapter's business: it says how these are spelled on the wire, what
// URL serves them and what a client may rely on. That is a promise to something
// already installed, and it changes for different reasons — see CONTRIBUTING.

/** A category and what it came to over a range. */
export interface CategoryTotal {
  readonly category: string;
  /** Negative for spending, positive for income. */
  readonly total: number;
  readonly count: number;
  /**
   * True when the category is the provider's own payment type rather than one we
   * produced. A bank's payment type is not a spending category, and counting it
   * as one overstates how much of the ledger is actually categorised.
   */
  readonly provisional: boolean;
}

/** One month's totals. `month` is YYYY-MM. */
export interface MonthTotal {
  readonly month: string;
  readonly income: number;
  readonly spend: number;
  readonly net: number;
  readonly count: number;
}

/** What the household spent and received over a range. */
export interface Summary {
  /** Null when the range holds no transactions — a value, not a missing field. */
  readonly currency: string | null;
  readonly from: string;
  readonly to: string;
  readonly transactionCount: number;
  readonly income: number;
  readonly spend: number;
  readonly net: number;
  readonly byCategory: readonly CategoryTotal[];
  readonly byMonth: readonly MonthTotal[];
  /**
   * Whether movement between the household's own accounts has been removed.
   * Reported rather than assumed, so an inflated total cannot be mistaken for a
   * real one.
   */
  readonly internalTransfersNetted: boolean;
  readonly transferCount: number;
  readonly transferTotal: number;
  readonly enrichedCount: number;
}

/** A transaction with its category resolved. */
export interface CategorisedTransaction {
  readonly dedupKey: string;
  readonly timestamp: string;
  /** Negative left the household, positive arrived. The one sign convention. */
  readonly amount: number;
  readonly currency: string;
  readonly description: string;
  readonly accountId: string;
  /** The provider's own type. Not the direction — see `amount`. */
  readonly transactionType: string;
  readonly providerCategory?: string | undefined;
  readonly category: string;
  readonly provisional: boolean;
}

/**
 * An account as currently known.
 *
 * Almost everything is optional because a row can exist without it: balances
 * arrive on their own endpoint and may land before account details, so an
 * account can legitimately be seen mid-sync with a balance and no identity.
 *
 * `isCard` absent means NOT YET KNOWN, never "no". Treating absent as false puts
 * a card's balance into the cash total and subtracts nothing, overstating the
 * household by twice the debt — the shape of the £567.90 bug. See #29.
 */
export interface AccountState {
  readonly accountId: string;
  readonly displayName?: string | undefined;
  readonly institutionName?: string | undefined;
  readonly currency?: string | undefined;
  readonly isCard?: boolean | undefined;
  readonly accountType?: string | undefined;
  /** Absent when never fetched, which is not the same as zero. */
  readonly currentBalance?: number | undefined;
  readonly availableBalance?: number | undefined;
  readonly lastSyncedAt?: string | undefined;
  /** Earliest date this account has any data for. */
  readonly historyFrom?: string | undefined;
  /**
   * False when the account demonstrably existed before the earliest data held,
   * so a total drawn before `historyFrom` is short by whatever it held. See #33.
   */
  readonly historyComplete?: boolean | undefined;
}

/** The household's net position on one day. */
export interface BalancePoint {
  readonly date: string;
  /** Cash less card debt, across every account with data that day. */
  readonly net: number;
}

export interface TransactionsResult {
  readonly range: DateRange;
  readonly transactions: readonly CategorisedTransaction[];
}

export interface AccountsResult {
  readonly accounts: readonly AccountState[];
  /**
   * Earliest date a household total is complete; absent when unconstrained.
   *
   * Computed here rather than left to callers. The rule is "the latest start
   * among accounts that are incomplete", and an account opened inside the range
   * must be excluded — a caller doing the obvious `max(historyFrom)` gets it
   * wrong the first time a new account is opened.
   */
  readonly completeFrom?: string | undefined;
}

export interface BalancesResult {
  /**
   * The range actually served, which may be narrower than the one requested.
   * Nothing incomplete is ever returned, so a request reaching further back than
   * coverage is clamped rather than answered with a total missing an account.
   */
  readonly range: DateRange;
  /** One per day across `range`, both ends inclusive. */
  readonly points: readonly BalancePoint[];
}

/**
 * What the application offers a driver: read-only reporting over one household's
 * ledger.
 *
 * Takes a tenant and a range, never an HTTP event. A driving adapter's job is to
 * turn its own protocol into these arguments and the results back into its own
 * representation — which is what keeps the four operations testable without a
 * request, and a driver testable without a ledger.
 */
export interface SummaryOptions {
  /**
   * Whether to remove movement between the household's own accounts.
   *
   * Defaults to true, which is what any ordinary reading of "what did we spend"
   * means: a transfer from current account to card is not spending, and counting
   * both legs inflates income and spend alike.
   *
   * Exposed because `Summary.internalTransfersNetted` already reports which way
   * it went, so the choice is plainly the caller's — and because the reconciliation
   * CLI shows netted against raw side by side, which is how anyone checks that the
   * transfer detection is finding real pairs rather than coincidences.
   */
  readonly nettingTransfers?: boolean;
}

export interface Reporting {
  summary(tenantId: string, range: DateRange, opts?: SummaryOptions): Promise<Summary>;
  transactions(tenantId: string, range: DateRange): Promise<TransactionsResult>;
  accounts(tenantId: string): Promise<AccountsResult>;
  balances(tenantId: string, range: DateRange): Promise<BalancesResult>;
}
