/**
 * The application's use cases: what it can be asked to do, independent of who
 * is asking.
 *
 * These were inlined in `route`, which meant every one of them could only be
 * reached by constructing an HTTP event. A CLI wanting the same answer had to
 * fabricate a request or reimplement the orchestration — and the second is not
 * hypothetical: the local dev server once kept its own copy of the routing,
 * drifted, and honoured a `limit` parameter the deployed handler ignored (#28).
 *
 * Nothing here knows about HTTP. No status codes, no events, no serialisation.
 * The controller translates; this decides.
 */

import type {
  AccountsResult,
  CategoriesResult,
  TransactionFilter,
  BalancesResult,
  DateRange,
  LedgerReads,
  SharedRuleSets,
  Reporting,
  SummaryOptions,
  Summary,
  TransactionsResult,
  RunningBalanceReport,
  AccountBalanceCheck,
} from "../index.js";
import { Category } from "../categorisation/category.js";
import { parseRuleSets, type RuleSet } from "../categorisation/rules.js";
import type { Adoptions } from "../categorisation/adoption.js";
import type { SetOrder } from "../categorisation/resolve.js";
import { filterMatcher, matchesMatcher } from "../categorisation/evaluate.js";
import { candidateOf } from "../application/candidate.js";
import { effectiveCategories, precedenceFor } from "./categories.js";
import { mergeCategories, summarise, toAccountState } from "./summary.js";
import type { RecordedTransaction } from "../ledger/transaction.js";
import {
  daysBetween,
  netPositionSeries,
  type AccountFacts,
  type Movement,
} from "./balances.js";
import {
  checkRunningBalanceChain,
  dailyPositionChecks,
} from "../ledger/running-balance.js";
import type { RunningBalanceVerdict } from "../ledger/running-balance.js";
import {
  clampToCoverage,
  completeFrom,
  coverageOf,
  type AccountCoverage,
} from "./coverage.js";

/**
 * The port's own vocabulary, re-exported under the name this module used.
 *
 * It was a separate declaration of the same two fields. A range of dates is
 * domain vocabulary and `@tightarse/domain` already owns it — a second copy is
 * how two things that must agree stop agreeing.
 */
export type Range = DateRange;

/**
 * The sets in force for a tenant, in the order they outrank each other.
 *
 * Two paths, and the second is the one going away.
 *
 * **Adopted:** each adoption names an owner, a set and a VERSION, so each is
 * fetched by exact key from whoever owns it. That is what makes the pin real —
 * a shared set improving does not reach a household until it adopts the newer
 * version. The sets come back in adoption order, so precedence is the order of
 * the list and nothing has to be ranked afterwards.
 *
 * **Fallback:** a tenant that has adopted nothing gets its own current sets,
 * ranked by the `order` they carry. That is every tenant today. It exists so
 * both forms can coexist without a data migration (#121) and goes when every
 * tenant has a list.
 *
 * An adoption naming a set that cannot be read is skipped rather than fatal. A
 * catalogue could retire a version, and a household losing one adopted set
 * should lose that set's rules, not its whole report.
 */
async function setsInForce(
  deps: Deps,
  tenantId: string,
  adoptions: Adoptions,
): Promise<{ sets: RuleSet[]; precedence: SetOrder[] }> {
  if (adoptions.length === 0) {
    const rows = await deps.ledger.listRuleSets(tenantId);
    return {
      sets: parseRuleSets(rows),
      precedence: precedenceFor([], rows),
    };
  }

  const fetched = await Promise.all(
    adoptions.map((a) =>
      deps.shared.getRuleSetVersion(a.owner, a.setId, a.version),
    ),
  );
  const sets = fetched.filter((s): s is RuleSet => s !== undefined);
  return {
    sets,
    precedence: sets.map((s, index) => ({ setId: s.setId, order: index })),
  };
}

/** Everything the use cases reach outside themselves. */
export interface Deps {
  readonly ledger: LedgerReads;
  /**
   * Reading a set that belongs to somebody else.
   *
   * Separate from `ledger` on purpose. It is the one capability here that
   * crosses a tenant boundary, and folding it into the general read port would
   * hand it to everything holding that port — which is exactly what giving it
   * its own port was meant to prevent (#121).
   */
  readonly shared: SharedRuleSets;
}

/**
 * Every transaction the household has, regardless of the range asked for.
 *
 * Coverage asks whether an account existed before its earliest transaction, and
 * a card's answer is derived by unwinding today's balance through every
 * transaction it has ever had. Both are questions about all of history, so
 * neither can be answered from a window — and `rangeFrom` defaults to a rolling
 * year, so answering them from the request would have reported every account's
 * history as starting a year ago.
 *
 * This constraint belongs to the use case. It lived in the HTTP handler, where
 * the next person adding a route would not have seen it.
 */
async function allHistory(
  deps: Deps,
  tenantId: string,
): Promise<RecordedTransaction[]> {
  const { transactions } = await deps.ledger.listRange(tenantId, {
    from: "1970-01-01",
    to: new Date().toISOString().slice(0, 10),
  });
  return transactions;
}

/** The ledger's account row, narrowed to what the balance maths needs. */
export function toAccountFacts(row: Record<string, unknown>): AccountFacts {
  return {
    accountId: String(row["accountId"] ?? ""),
    ...(typeof row["isCard"] === "boolean" ? { isCard: row["isCard"] } : {}),
    ...(typeof row["currentBalance"] === "number"
      ? { currentBalance: row["currentBalance"] }
      : {}),
    ...(typeof row["lastSyncedAt"] === "string"
      ? { balanceAsOf: (row["lastSyncedAt"] as string).slice(0, 10) }
      : {}),
  };
}

/** Transactions, narrowed the same way. */
export function toMovements(rows: readonly RecordedTransaction[]): Movement[] {
  return rows.map((r) => ({
    accountId: r.accountId,
    timestamp: r.timestamp,
    amount: r.amount,
    dedupKey: r.dedupKey,
    ...((r as { runningBalance?: number }).runningBalance !== undefined
      ? { runningBalance: (r as { runningBalance?: number }).runningBalance }
      : {}),
  }));
}

/**
 * Coverage per account, keyed by id.
 *
 * Computed in one place so `accounts` and `balances` cannot disagree about which
 * accounts are complete — a disagreement would show as a chart clamped to one
 * date while the account list explains a different one.
 */
function coverageFor(
  rows: readonly Record<string, unknown>[],
  txns: readonly RecordedTransaction[],
): Map<string, AccountCoverage> {
  const movements = toMovements(txns);
  const byAccount = new Map<string, Movement[]>();
  for (const m of movements)
    byAccount.set(m.accountId, [...(byAccount.get(m.accountId) ?? []), m]);
  return new Map(
    rows.map((row) => {
      const facts = toAccountFacts(row);
      return [
        facts.accountId,
        coverageOf(facts, byAccount.get(facts.accountId) ?? []),
      ] as const;
    }),
  );
}

export async function summary(
  deps: Deps,
  tenantId: string,
  range: Range,
  opts: SummaryOptions = {},
): Promise<Summary> {
  const [{ transactions, categorisations }, adoptions] = await Promise.all([
    deps.ledger.listRange(tenantId, range),
    deps.ledger.getAdoptions(tenantId),
  ]);
  const { precedence } = await setsInForce(deps, tenantId, adoptions);
  return summarise(
    transactions,
    effectiveCategories(transactions, categorisations, precedence),
    range,
    // `transfers: false` disables detection; the default enables it.
    opts.nettingTransfers === false ? { transfers: false } : {},
  );
}

/**
 * Transactions in a range, optionally narrowed.
 *
 * Narrowed by the same function that builds a rule from the same filter, so a
 * screen showing these rows and then writing a rule is showing exactly what the
 * rule will take. Not because a search has to equal a rule in principle — the
 * dry run answers what a rule does, over the whole ledger — but because when
 * the two are built from one thing they cannot drift.
 *
 * Filtered after the read rather than in the query, because the ledger is keyed
 * by date and nothing indexes a description. The read is the cost either way;
 * what this saves is sending five years of transactions to a client that wanted
 * eleven of them.
 */
export async function transactions(
  deps: Deps,
  tenantId: string,
  range: Range,
  filter?: TransactionFilter,
): Promise<TransactionsResult> {
  const [{ transactions: txns, categorisations }, adoptions] =
    await Promise.all([
      deps.ledger.listRange(tenantId, range),
      deps.ledger.getAdoptions(tenantId),
    ]);
  const { precedence } = await setsInForce(deps, tenantId, adoptions);

  const rows = txns;
  // Built once, not per row: escaping a term eleven thousand times to reach the
  // same answer is work for nothing.
  const matcher = filter === undefined ? undefined : filterMatcher(filter);
  const wanted =
    matcher === undefined
      ? rows
      : rows.filter((row) => matchesMatcher(matcher, candidateOf(row)));

  return {
    range,
    transactions: mergeCategories(
      wanted,
      effectiveCategories(rows, categorisations, precedence),
    ),
  };
}

/**
 * The categories a household may choose from.
 *
 * Retired ones are excluded rather than flagged. A retired category is one
 * nothing new should be filed under — offering it and refusing it afterwards is
 * a worse conversation than not offering it — and existing categorisations that
 * name one are resolved through its merge chain, which is a different question
 * from what a picker should show.
 *
 * Sorted by label, because a list somebody reads is ordered the way they read.
 */
export async function categories(
  deps: Deps,
  tenantId: string,
): Promise<CategoriesResult> {
  const catalogue = (await deps.ledger.listCategories(tenantId)).map((r) =>
    Category.parse(r),
  );
  return {
    categories: catalogue
      .filter((c) => !c.retired)
      .map((c) => ({ id: c.id, label: c.label, kind: c.kind }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

export async function accounts(
  deps: Deps,
  tenantId: string,
): Promise<AccountsResult> {
  const [rows, all] = await Promise.all([
    deps.ledger.listAccounts(tenantId),
    allHistory(deps, tenantId),
  ]);
  const coverage = coverageFor(rows, all);
  const complete = completeFrom([...coverage.values()]);
  return {
    accounts: rows.map((row) => {
      const c = coverage.get(String(row["accountId"]));
      return {
        ...toAccountState(row),
        ...(c?.historyFrom !== undefined ? { historyFrom: c.historyFrom } : {}),
        ...(c?.historyComplete !== undefined
          ? { historyComplete: c.historyComplete }
          : {}),
      };
    }),
    ...(complete !== undefined ? { completeFrom: complete } : {}),
  };
}

/**
 * Net position per day, over the range that can honestly be drawn.
 *
 * Clamped rather than answered in full: a total drawn before every account has
 * data omits one, and for a card it omits debt, so the line reads high and looks
 * entirely plausible. The range actually served is returned, so a caller can
 * tell it was narrowed.
 */
export async function balances(
  deps: Deps,
  tenantId: string,
  range: Range,
): Promise<BalancesResult> {
  const [rows, all] = await Promise.all([
    deps.ledger.listAccounts(tenantId),
    allHistory(deps, tenantId),
  ]);
  const complete = completeFrom([...coverageFor(rows, all).values()]);
  const served = clampToCoverage(range, complete);
  return {
    range: served,
    // The whole history, not `served`. A card's balance on a given day is what is
    // owed today less everything since, so transactions after the requested range
    // are load-bearing.
    points: netPositionSeries(
      rows.map(toAccountFacts),
      toMovements(all),
      daysBetween(served.from, served.to),
    ),
  };
}

/**
 * Bind the use cases to their dependencies, as the inbound port.
 *
 * This is what a driver depends on. Before it existed the three drivers — the
 * Lambda, the local server and the report CLI — each reached in at whatever depth
 * suited them, and the CLI went straight past these functions to the aggregation
 * with its own casts.
 *
 * The `Reporting` annotation is the check: it is what makes the four return types
 * above a promise rather than an inference, so widening a total is a deliberate
 * edit to the port instead of something that leaks out to a client.
 */
export function reporting(deps: Deps): Reporting {
  return {
    summary: (tenantId, range, opts) => summary(deps, tenantId, range, opts),
    transactions: (tenantId, range, filter) =>
      transactions(deps, tenantId, range, filter),
    categories: (tenantId) => categories(deps, tenantId),
    accounts: (tenantId) => accounts(deps, tenantId),
    balances: (tenantId, range) => balances(deps, tenantId, range),
    runningBalanceCheck: (tenantId) => runningBalanceCheck(deps, tenantId),
  };
}

/**
 * What `running_balance` means, answered from the household's own ledger.
 *
 * A diagnostic, and the only way the question can be settled: the provider does
 * not document whether the figure is the position before or after its
 * transaction, three places here assume "after", and nothing we run would catch
 * the assumption being wrong. #108 step 2 makes every balance depend on it.
 *
 * Whole history rather than a range, for the same reason `balances` uses it: a
 * chain judged on a window says only that the window is self-consistent.
 */
export async function runningBalanceCheck(
  deps: Deps,
  tenantId: string,
): Promise<RunningBalanceReport> {
  const [rows, all] = await Promise.all([
    deps.ledger.listAccounts(tenantId),
    allHistory(deps, tenantId),
  ]);

  const movements = toMovements(all);
  const byAccount = new Map<string, Movement[]>();
  for (const m of movements)
    byAccount.set(m.accountId, [...(byAccount.get(m.accountId) ?? []), m]);

  const accounts = rows.map(toAccountFacts).map((facts) => {
    const mine = byAccount.get(facts.accountId) ?? [];
    const chain = checkRunningBalanceChain(mine);
    const days = dailyPositionChecks(mine);
    return {
      accountId: facts.accountId,
      isCard: facts.isCard === true,
      verdict: chain.verdict,
      pairs: chain.pairs,
      discriminating: chain.discriminating,
      closingMatches: chain.closingMatches,
      openingMatches: chain.openingMatches,
      daysChecked: days.length,
      disagreeing: days.filter((d) => d.difference !== 0),
    };
  });

  return { verdict: overallVerdict(accounts), accounts };
}

/**
 * One answer for the whole ledger.
 *
 * Accounts with nothing to compare are ignored rather than counted against the
 * result — every card is one, and letting them outvote the accounts that do
 * carry a chain would turn a clear answer into no answer. A single inconsistent
 * account is decisive though: it means the chain is broken somewhere, and no
 * reading of the field repairs that.
 */
function overallVerdict(
  accounts: readonly AccountBalanceCheck[],
): RunningBalanceVerdict {
  const informative = accounts.filter((a) => a.verdict !== "insufficient");
  if (informative.length === 0) return "insufficient";
  if (informative.some((a) => a.verdict === "inconsistent")) return "inconsistent";
  const distinct = new Set(informative.map((a) => a.verdict));
  if (distinct.size === 1) return [...distinct][0]!;
  // Some accounts discriminate and others do not: the ones that do decide it.
  const decided = new Set(
    informative.filter((a) => a.verdict !== "ambiguous").map((a) => a.verdict),
  );
  return decided.size === 1 ? [...decided][0]! : "inconsistent";
}
