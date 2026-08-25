/**
 * Inbound ports: what the application offers, to whatever drives it.
 *
 * The other side of the hexagon from `../outbound`. It was missing for a long
 * time, and its absence had a cost: the four operations below already had three
 * drivers — the Lambda entry point, the local HTTP server and the report CLI —
 * and each reached in at whatever depth suited it. Because the functions had no
 * declared return type, what the API promised was inferred from whatever the
 * aggregation happened to return, so a change in the shape of a total could reach
 * a client without failing a build.
 *
 * The types here are domain vocabulary, not wire format. `@tightarse/api-contract`
 * is the HTTP adapter's business: how these are spelled on the wire, what URL
 * serves them, and what a client may rely on.
 */

import type { DateRange } from "../index.js";
import type { AccountId } from "../../ledger/account.js";
import type { DescriptionSummary, Recurrence } from "../../categorisation/corpus.js";
import type { Conflict, Gap } from "../../categorisation/evidence.js";

/** A category and what it came to over a range. */
export interface CategoryTotal {
  readonly category: string;
  /** Negative for spending, positive for income. */
  readonly total: number;
  readonly count: number;
  /**
   * True when every transaction in this category came from the provider's own
   * payment type rather than a rule set. A bank's payment type is not a spending
   * category, and counting it as one overstates how much of the ledger is
   * actually categorised.
   *
   * Still a boolean here, because "which set" is not single-valued across a
   * group. On a transaction it is `setId`, which says more.
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
  /**
   * Which rule set produced the category, `provider` where nothing did.
   *
   * Replaces a `provisional` boolean. Trust is a property of a set, so a client
   * that knows the set knows everything the flag said and can say more — and it
   * stops being something every consumer has to remember to check.
   */
  readonly setId: string;
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

/** Every categorised transaction in a range, newest first. */
export interface TransactionsResult {
  readonly range: DateRange;
  readonly transactions: readonly CategorisedTransaction[];
}

/** Every account the household holds, with its latest known state. */
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

/** Balances over time: one series per account, plus the household's net position. */
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

/**
 * What the rules do not cover, and the shapes a rule could be written against.
 *
 * Holds descriptions, which are household data. For a terminal, an authorised
 * API response or a proposer in memory — never for a file.
 */
export interface Backlog {
  /** Every distinct description, costliest first. */
  readonly descriptions: readonly DescriptionSummary[];
  /** Amounts arriving on a beat, which is how a payment whose reference changes every month stays findable. */
  readonly recurrences: readonly Recurrence[];
  /** What nothing matched, costliest first. */
  readonly gaps: readonly Gap[];
  /**
   * Where a set claims two answers at once, widest first.
   *
   * A conflict is a gap with a cause. The set produces nothing, so the affected
   * transactions sit in `gaps` looking like merchants nobody has written a rule
   * for — when in fact two rules exist and disagree. Without this, anyone
   * reading the backlog is being pointed at the wrong problem.
   */
  readonly conflicts: readonly Conflict[];
  readonly scanned: number;
}

/**
 * Describing what the rules do not cover.
 *
 * Separate from `Reporting` because it answers a different question for a
 * different reader: reporting says what the household spent, this says what the
 * rules have failed to explain.
 */
export interface Inspection {
  /** Everything a proposer needs about one household's ledger over a range. */
  backlog(tenantId: string, range: DateRange): Promise<Backlog>;
}

/**
 * What the household can be shown.
 *
 * The read side in full. Every driver — the Lambda, the local HTTP server, the
 * report CLI — goes through exactly these four, so a change in what a total
 * means cannot reach one of them without reaching all three.
 */
export interface Reporting {
  summary(tenantId: string, range: DateRange, opts?: SummaryOptions): Promise<Summary>;
  transactions(tenantId: string, range: DateRange): Promise<TransactionsResult>;
  accounts(tenantId: string): Promise<AccountsResult>;
  balances(tenantId: string, range: DateRange): Promise<BalancesResult>;
}

/**
 * What the check made of one account.
 *
 * Counts, never amounts. A discrepancy is a balance, and a balance is as
 * personal as a transaction — this output reaches CloudWatch.
 *
 * Nothing here says whether the account is a card. The caller read the accounts
 * in the first place and already knows; carrying it would put a provider's
 * product taxonomy into a domain result that makes no use of it.
 */
export interface AccountReconciliation {
  /** How many balance readings this account had in the ledger. */
  readonly readings: number;
  /**
   * 1 when there were enough readings to check, 0 otherwise.
   *
   * Zero is the normal state of a newly connected account and of every account
   * until a second sync has run, and it is not a failure. It must stay
   * distinguishable from zero breaks, or "nothing was checked" reads as
   * "everything is healthy".
   */
  readonly checked: number;
  /**
   * 1 when the arithmetic did not come out, 0 otherwise.
   *
   * Never more than 1: the check compares the whole span from oldest reading to
   * newest, not each consecutive pair, so an account either reconciles over its
   * series or does not.
   */
  readonly breaks: number;
}

/**
 * What a reconciliation run found, keyed by account.
 *
 * The totals are the same numbers summed, carried because every caller wants
 * them and summing a record at four call sites invites four different answers.
 * `breaks <= checked <= size of accounts` always holds.
 */
export interface ReconciliationReport {
  /** Every account the run looked at, whether or not it could be checked. */
  readonly accounts: Readonly<Record<AccountId, AccountReconciliation>>;
  /** Accounts with enough readings to check. */
  readonly checked: number;
  /** Accounts whose arithmetic did not come out. */
  readonly breaks: number;
}

/** Check the ledger's arithmetic against the balances the banks reported. */
export interface Reconciliation {
  /** Check every account this household holds, and record what was found. */
  run(tenantId: string): Promise<ReconciliationReport>;
}
