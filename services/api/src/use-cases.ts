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

import type { LedgerReads } from "@tightarse/ports";
import { mergeEnrichments, summarise, toAccountView, type EnrichmentRow, type LedgerRow } from "./aggregate.js";
import { daysBetween, netPositionSeries, type AccountFacts, type Movement } from "./balances.js";
import { clampToCoverage, completeFrom, coverageOf, type AccountCoverage } from "./coverage.js";

export interface Range {
  readonly from: string;
  readonly to: string;
}

/** Everything the use cases reach outside themselves. */
export interface Deps {
  readonly ledger: LedgerReads;
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
async function allHistory(deps: Deps, tenantId: string): Promise<LedgerRow[]> {
  const { transactions } = await deps.ledger.listRange(tenantId, {
    from: "1970-01-01",
    to: new Date().toISOString().slice(0, 10),
  });
  return transactions as unknown as LedgerRow[];
}

/** The ledger's account row, narrowed to what the balance maths needs. */
export function toAccountFacts(row: Record<string, unknown>): AccountFacts {
  return {
    accountId: String(row["accountId"] ?? ""),
    ...(typeof row["isCard"] === "boolean" ? { isCard: row["isCard"] } : {}),
    ...(typeof row["currentBalance"] === "number" ? { currentBalance: row["currentBalance"] } : {}),
    ...(typeof row["lastSyncedAt"] === "string"
      ? { balanceAsOf: (row["lastSyncedAt"] as string).slice(0, 10) }
      : {}),
  };
}

/** Transactions, narrowed the same way. */
export function toMovements(rows: readonly LedgerRow[]): Movement[] {
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
  txns: readonly LedgerRow[],
): Map<string, AccountCoverage> {
  const movements = toMovements(txns);
  const byAccount = new Map<string, Movement[]>();
  for (const m of movements) byAccount.set(m.accountId, [...(byAccount.get(m.accountId) ?? []), m]);
  return new Map(
    rows.map((row) => {
      const facts = toAccountFacts(row);
      return [facts.accountId, coverageOf(facts, byAccount.get(facts.accountId) ?? [])] as const;
    }),
  );
}

export async function summary(deps: Deps, tenantId: string, range: Range) {
  const { transactions, enrichments } = await deps.ledger.listRange(tenantId, range);
  return summarise(
    transactions as unknown as LedgerRow[],
    enrichments as unknown as EnrichmentRow[],
    range,
  );
}

export async function transactions(deps: Deps, tenantId: string, range: Range) {
  const { transactions: txns, enrichments } = await deps.ledger.listRange(tenantId, range);
  return {
    range,
    transactions: mergeEnrichments(
      txns as unknown as LedgerRow[],
      enrichments as unknown as EnrichmentRow[],
    ),
  };
}

export async function accounts(deps: Deps, tenantId: string) {
  const [rows, all] = await Promise.all([deps.ledger.listAccounts(tenantId), allHistory(deps, tenantId)]);
  const coverage = coverageFor(rows, all);
  const complete = completeFrom([...coverage.values()]);
  return {
    accounts: rows.map((row) => {
      const c = coverage.get(String(row["accountId"]));
      return {
        ...toAccountView(row),
        ...(c?.historyFrom !== undefined ? { historyFrom: c.historyFrom } : {}),
        ...(c?.historyComplete !== undefined ? { historyComplete: c.historyComplete } : {}),
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
export async function balances(deps: Deps, tenantId: string, range: Range) {
  const [rows, all] = await Promise.all([deps.ledger.listAccounts(tenantId), allHistory(deps, tenantId)]);
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
