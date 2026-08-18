import { DynamoStore } from "@tightarse/dynamodb";
import { mergeEnrichments, summarise, toAccountView, type EnrichmentRow, type LedgerRow } from "./aggregate.js";
import { daysBetween, netPositionSeries, type AccountFacts, type Movement } from "./balances.js";
import { clampToCoverage, completeFrom, coverageOf } from "./coverage.js";
import type { LedgerReads } from "@tightarse/ports";

/**
 * HTTP API handler.
 *
 * The tenant comes from the verified JWT claim and NEVER from the request.
 * A query parameter would let any authenticated household read any other's
 * ledger — the single most important line in this file.
 */

interface HttpEvent {
  rawPath?: string;
  queryStringParameters?: Record<string, string | undefined> | null;
  requestContext?: {
    authorizer?: { jwt?: { claims?: Record<string, unknown> } };
  };
}

/**
 * Everything this handler reaches outside itself.
 *
 * A structural type rather than `Ledger`, so a test supplies the two methods
 * the routes use and the compiler still checks every call. The client used to
 * be built at module scope, which put the routing — including the tenant rule
 * below, the single most important line in this file — behind a constructor
 * that needs a table and a region, and left it entirely untested.
 */
export interface ApiDeps {
  readonly ledger: LedgerReads;
}

/**
 * Where the ledger client points, read from the environment.
 *
 * Separate and taking `env` as an argument so both sides of each fallback are
 * testable. Inline, they were only ever exercised on whichever side the running
 * machine happened to be on — `AWS_REGION` is set in CI and unset on a laptop,
 * so branch coverage differed between the two and a threshold pinned locally
 * failed the build in CI.
 */
export function ledgerConfig(env: NodeJS.ProcessEnv): { tableName: string; region: string } {
  return {
    tableName: env["TABLE_NAME"] ?? "",
    region: env["AWS_REGION"] ?? "eu-west-1",
  };
}

/** Built by the entry point below, and by nothing a test runs. */
export function realDeps(): ApiDeps {
  return {
    ledger: new DynamoStore(ledgerConfig(process.env)),
  };
}

function tenantFrom(event: HttpEvent): string {
  const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
  // Custom attribute set at user creation. A user with no household must not
  // fall back to a default — that would silently grant access to someone
  // else's data.
  const tenant = claims["custom:tenant"];
  if (typeof tenant !== "string" || tenant.length === 0) {
    throw Object.assign(new Error("No household on this identity"), { statusCode: 403 });
  }
  return tenant;
}

function rangeFrom(event: HttpEvent): { from: string; to: string } {
  const q = event.queryStringParameters ?? {};
  const to = q["to"] ?? new Date().toISOString().slice(0, 10);
  // Default to a rolling year: long enough to be useful, bounded so an
  // unqualified request cannot pull five years across the wire.
  const from = q["from"] ?? new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  if (from > to) {
    throw Object.assign(new Error("`from` is after `to`"), { statusCode: 400 });
  }
  return { from, to };
}

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
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
 * Every transaction the household has, regardless of the requested range.
 *
 * Coverage asks whether an account existed before its earliest transaction, and
 * a card's answer is derived by unwinding today's balance through every
 * transaction it has ever had. Both are questions about all of history, so
 * neither can be answered from a window.
 *
 * This reads the full ledger — a few thousand rows today. If it becomes slow,
 * the fix is a per-account summary maintained by the transform at write time,
 * not a narrower read here, which would only make the answer wrong faster.
 */
async function allHistory(deps: ApiDeps, tenantId: string): Promise<LedgerRow[]> {
  const { transactions } = await deps.ledger.listRange(tenantId, {
    from: "1970-01-01",
    to: new Date().toISOString().slice(0, 10),
  });
  return transactions as unknown as LedgerRow[];
}

/**
 * Coverage per account, keyed by id.
 *
 * Both `/accounts` and `/balances` need it, and computing it in one place means
 * they cannot disagree about which accounts are complete — a disagreement would
 * show as a chart clamped to one date while the accounts list explains a
 * different one.
 */
function coverageFor(rows: readonly Record<string, unknown>[], txns: readonly LedgerRow[]) {
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

export async function route(deps: ApiDeps, event: HttpEvent) {
  try {
    const tenantId = tenantFrom(event);
    const range = rangeFrom(event);
    const path = event.rawPath ?? "/";

    // Read what each route actually needs, rather than a range read up front.
    // `/accounts` and `/balances` both need the *whole* history and would have
    // been silently wrong sharing the range read: `rangeFrom` defaults to a
    // rolling year, so an unqualified `/accounts` would have reported every
    // account's history as starting a year ago and produced a `completeFrom`
    // that moved with the calendar.
    if (path.endsWith("/summary") || path.endsWith("/transactions")) {
      const { transactions, enrichments } = await deps.ledger.listRange(tenantId, range);
      const txns = transactions as unknown as LedgerRow[];
      const enr = enrichments as unknown as EnrichmentRow[];
      return path.endsWith("/summary")
        ? json(200, summarise(txns, enr, range))
        : json(200, { range, transactions: mergeEnrichments(txns, enr) });
    }

    if (path.endsWith("/accounts")) {
      const [rows, all] = await Promise.all([deps.ledger.listAccounts(tenantId), allHistory(deps, tenantId)]);
      const coverage = coverageFor(rows, all);
      const complete = completeFrom([...coverage.values()]);
      return json(200, {
        accounts: rows.map((row) => {
          const c = coverage.get(String(row["accountId"]));
          return {
            ...toAccountView(row),
            ...(c?.historyFrom !== undefined ? { historyFrom: c.historyFrom } : {}),
            ...(c?.historyComplete !== undefined ? { historyComplete: c.historyComplete } : {}),
          };
        }),
        ...(complete !== undefined ? { completeFrom: complete } : {}),
      });
    }

    if (path.endsWith("/balances")) {
      const [rows, all] = await Promise.all([deps.ledger.listAccounts(tenantId), allHistory(deps, tenantId)]);
      const complete = completeFrom([...coverageFor(rows, all).values()]);
      // Clamped rather than answered in full: a total drawn before every
      // account has data omits one, and for a card it omits debt, so the line
      // reads high and looks entirely plausible. #33.
      const served = clampToCoverage(range, complete);
      const days = daysBetween(served.from, served.to);
      return json(200, {
        range: served,
        // The whole history, not `served`. A card's balance on a given day is
        // what is owed today less everything since, so transactions *after* the
        // requested range are load-bearing — cutting the read at `to` would
        // make every card's history wrong by whatever happened afterwards.
        points: netPositionSeries(rows.map(toAccountFacts), toMovements(all), days),
      });
    }
    return json(404, { error: `No route for ${path}` });
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    const message = err instanceof Error ? err.message : "Unknown error";
    // Never echo the underlying error for a 500 — it can carry key material
    // and table structure.
    return json(statusCode, { error: statusCode === 500 ? "Internal error" : message });
  }
}

/**
 * Lambda entry point, and the only place a client is constructed.
 *
 * Memoised so a warm container reuses the connection pool, which is what the
 * module-scope constructor was buying. Deferring it to the first call keeps
 * that and leaves the module importable without a table configured.
 */
let deps: ApiDeps | undefined;

export async function handler(event: HttpEvent) {
  deps ??= realDeps();
  return route(deps, event);
}
