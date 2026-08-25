import { DynamoStore } from "@tightarse/dynamodb";
import type { Reporting } from "@tightarse/domain";
import { reporting } from "@tightarse/domain";
import { asAccounts, asBalances, asSummary, asTransactions } from "./wire.js";

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
  /**
   * The inbound port, not the ledger.
   *
   * This used to be `LedgerReads`, which meant testing the routing — including
   * the tenant rule below, the single most important line in this file — required
   * ledger rows and ran the whole aggregation underneath. An adapter should be
   * testable against the application it drives, not through it.
   */
  readonly reporting: Reporting;
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
    // The composition root: the concrete store is constructed here and nowhere
    // else, then bound to the inbound port the routing depends on.
    reporting: reporting({ ledger: new DynamoStore(ledgerConfig(process.env)) }),
  };
}

/**
 * The household, from the verified claim and never from the request.
 *
 * Exported because the categorisation routes need the same rule, and two copies
 * of the single most important line in this codebase is how one of them ends up
 * subtly different. Anything serving a household read or write goes through
 * this and nothing else.
 */
export function tenantFrom(event: { requestContext?: { authorizer?: { jwt?: { claims?: Record<string, unknown> } } } }): string {
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





export async function route(deps: ApiDeps, event: HttpEvent) {
  try {
    const tenantId = tenantFrom(event);
    const range = rangeFrom(event);
    const path = event.rawPath ?? "/";

    // Each result goes through `wire.ts`, which is where the domain answer meets
    // the promise made to installed clients.
    if (path.endsWith("/summary")) return json(200, asSummary(await deps.reporting.summary(tenantId, range)));
    if (path.endsWith("/transactions"))
      return json(200, asTransactions(await deps.reporting.transactions(tenantId, range)));
    if (path.endsWith("/accounts")) return json(200, asAccounts(await deps.reporting.accounts(tenantId)));
    if (path.endsWith("/balances"))
      return json(200, asBalances(await deps.reporting.balances(tenantId, range)));

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
