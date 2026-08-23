/**
 * Outbound ports: what the application needs of the world, declared by the side
 * that needs it rather than by the side that provides it.
 *
 * These used to be `Pick<Ledger, "listRange" | "listAccounts">` at each call site
 * — a view onto the adapter rather than an interface the domain owns. With a
 * `Pick`, adding a method to the adapter silently widens what every consumer may
 * reach for, and nothing can fail to satisfy a contract defined as "whatever that
 * class happens to have".
 *
 * Two planes, and the line between them is the one this codebase enforces
 * everywhere else:
 *
 * - **Data** is derived and rebuildable. A replay of the raw zone reproduced the
 *   whole transaction ledger identically, so anything here can be regenerated.
 * - **Control** is authored and irreplaceable. Nothing regenerates a household's
 *   own rules, its members, or a correction somebody made by hand.
 */

import type { Account } from "../../ledger/account.js";
import type { Transaction } from "../../ledger/transaction.js";
import type { BalanceReading } from "../../ledger/balance.js";
import type { ReconciliationMovement, Reading } from "../../ledger/reconciliation.js";
import type { AccountId } from "../../ledger/account.js";
import type { Categorisation } from "../../categorisation/categorisation.js";
import type { Category } from "../../categorisation/category.js";
import type { RuleSet } from "../../categorisation/rules.js";
import type { Evidence } from "../../categorisation/evidence.js";
import type { CustomRule, TransactionEnrichment } from "../../categorisation/enrichment.js";
import type { Member } from "../../household/member.js";
import type { TenantSettings } from "../../household/settings.js";
import type { Consent } from "../../household/consent.js";
import type { DateRange } from "../index.js";

/** A stored row, as the adapter currently returns it. */
export type Row = Record<string, unknown>;

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

/**
 * The category catalogue.
 *
 * Categories are never deleted — merging is a relationship, so no taxonomy
 * change requires reprocessing — which is why there is no remove here.
 */
export interface Categories {
  /** Write one. Overwrites in place: a label or colour is presentation. */
  putCategory(tenantId: string, category: Category): Promise<void>;
  /** Every category, for resolution at read. */
  listCategories(tenantId: string): Promise<Row[]>;
}

/**
 * Whatever suggests how the rules should change.
 *
 * A port because the suggestion is a policy, not a fact: a deterministic pass
 * over conflicts, a person with an editor, or a model reading the same evidence
 * are all the same operation with a different opinion behind it. The design says
 * a model authors rules and never classifies transactions — this is the door it
 * comes through, and it faces the same checks as any other.
 *
 * Sets are returned whole rather than as a delta. A set version is what gets
 * written and what a categorisation's provenance names, so a proposal that
 * cannot be expressed as a version is one nothing can record.
 */
export interface RuleProposer {
  /** How a proposal is attributed. Recorded when one is accepted. */
  readonly proposedBy: string;
  /**
   * Suggest what the sets should become, given what they currently do.
   *
   * Returning nothing is a legitimate answer, and the default one.
   */
  propose(evidence: Evidence, sets: readonly RuleSet[]): Promise<readonly RuleSet[]>;
}

/** Categorisations. Current rows arrive via `Transactions.listRange`. */
export interface Categorisations {
  putCategorisation(tenantId: string, c: Categorisation): Promise<void>;
  listCategorisationHistory(tenantId: string, dedupKey: string): Promise<Row[]>;
}

/** Where accounts are stored, and read back. */
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

/** Where balance readings are stored. Append-only: a reading is a fact about a moment. */
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
  /**
   * The rule sets, for their precedence.
   *
   * A report cannot say which category is in force without knowing which set
   * outranks which, and that is data rather than load order. It is a read of the
   * same tenant partition `listAccounts` already touches.
   */
  listRuleSets(tenantId: string): Promise<Row[]>;
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
/**
 * What reconciliation reads: the accounts, and the two series behind each one.
 *
 * Three calls rather than one bulk read because the adapter is free to satisfy
 * them from a single consistent scan — which is what it does, and must: reading
 * one account's balances against another's transactions would produce a
 * confident wrong answer that nothing downstream could catch.
 *
 * Stored rows never appear here. Grouping one into these is storage's job, and
 * this package must not learn that a reading has a partition key.
 */
export interface ReconciliationData {
  /** Every account to check. Ids only — the check makes no use of anything else. */
  accounts(): Promise<readonly AccountId[]>;
  /** One account's balance readings, in any order; the check sorts them. */
  readings(accountId: AccountId): Promise<readonly Reading[]>;
  /** One account's transactions, across at least the span being checked. */
  movements(accountId: AccountId): Promise<readonly ReconciliationMovement[]>;
}

/**
 * Recording what the reconciliation made of a balance reading.
 *
 * A mark on the reading itself rather than a correcting transaction: a
 * synthetic row that makes the arithmetic come out is a healthy-looking number
 * over missing data, and it would have to be retracted later. Marks can simply
 * be cleared when a late transaction explains the break.
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

/** What a provider hands back for a set of credentials. */
export interface BankToken {
  readonly accessToken: string;
  /**
   * May be a NEW token, with the old one invalidated. A caller that keeps the
   * original has a connection that dies quietly a few days later.
   */
  readonly refreshToken: string;
  /** Absolute, so a stored token can be judged later without knowing when it was issued. */
  readonly expiresAt: string;
}

/**
 * One provider response, ready to land in the raw zone unchanged.
 *
 * `dataset` is provider-shaped by design — it names the endpoint the body came
 * from, keys the raw object, and is what a replay reads to know how to interpret
 * it. Flattening it to something provider-neutral would make old raw objects
 * unreadable, which defeats the point of keeping them.
 */
export interface BankPayload {
  readonly dataset: string;
  /** The account or card this belongs to; null for a listing. */
  readonly itemId: string | null;
  readonly body: unknown;
  /** The window requested, when the endpoint takes one. Recorded with the object. */
  readonly window?: DateRange | undefined;
}

/** An account or card the provider holds for a connection. */
export interface BankItem {
  /** The provider's own grouping, e.g. accounts or cards. Recorded, not interpreted. */
  readonly resource: string;
  readonly itemId: string;
}

/**
 * Measured facts about one provider.
 *
 * Not configuration and not guesses: 60 months is where TrueLayer starts
 * returning `invalid_date_range` instantly, and 88 days is the unattended cap
 * less the margin providers under-deliver by.
 */
export interface BankLimits {
  readonly maxHistoryMonths: number;
  readonly unattendedHistoryDays: number;
  /** How long the deep-history exemption lasts after a consent, in minutes. */
  readonly exemptionMinutes: number;
}

/**
 * A consent that can only be fixed by a person re-authorising.
 *
 * The one provider failure the application must tell apart, because retrying it
 * is pointless and reporting it as a transient error hides work only a human can
 * do. Everything else a provider refuses — an endpoint it does not offer, a
 * resource it does not have — is the adapter's business and comes back as
 * `skipped`.
 */
export class ConsentExpired extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsentExpired";
  }
}

/**
 * The provider, as the sync sees it.
 *
 * Everything that needs a live connection to a bank. Implemented by the
 * TrueLayer adapter, which is also where the provider's shapes and its sign
 * convention are normalised — nothing behind this port sees either.
 */
export interface BankData {
  /** Measured facts about this provider. See BankLimits. */
  readonly limits: BankLimits;
  /**
   * Data calls made so far against the unattended cap.
   *
   * Four per account, endpoint and consent per 24 hours, so one call per resource
   * per run leaves room for four runs a day and it is a retry loop that breaches
   * it. Failed calls count, because the provider counts them. Token refreshes do
   * not: they are not data calls.
   */
  readonly calls: number;

  /** Exchange a refresh token. Throws ConsentExpired when only a person can fix it. */
  refresh(refreshToken: string): Promise<BankToken>;

  /**
   * Every account and card, and the listings to land.
   *
   * `skipped` names resources this provider does not offer — Amex is cards-only,
   * with no accounts scope at all. Treating that as a failure aborts an Amex sync
   * before it fetches anything.
   */
  listItems(accessToken: string): Promise<{
    items: readonly BankItem[];
    payloads: readonly BankPayload[];
    skipped: readonly string[];
  }>;

  /**
   * Everything held about one item, over a window.
   *
   * `transactions` is counted here because this is the only place that sees the
   * response, and it is what anomaly detection watches: a current account doing
   * thirty a day dropping to zero is a signal nothing else in a run would show.
   */
  fetchItem(
    accessToken: string,
    item: BankItem,
    window: DateRange,
  ): Promise<{
    payloads: readonly BankPayload[];
    skipped: readonly string[];
    transactions: number;
  }>;
}
