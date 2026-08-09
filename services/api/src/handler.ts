import { Ledger } from "@tightarse/ledger";
import { mergeEnrichments, summarise, type EnrichmentRow, type LedgerRow } from "./aggregate.js";

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

const ledger = new Ledger({
  tableName: process.env["TABLE_NAME"] ?? "",
  region: process.env["AWS_REGION"] ?? "eu-west-1",
});

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

export async function handler(event: HttpEvent) {
  try {
    const tenantId = tenantFrom(event);
    const range = rangeFrom(event);
    const path = event.rawPath ?? "/";

    const { transactions, enrichments } = await ledger.listRange(tenantId, range);
    const txns = transactions as unknown as LedgerRow[];
    const enr = enrichments as unknown as EnrichmentRow[];

    if (path.endsWith("/summary")) {
      return json(200, summarise(txns, enr, range));
    }
    if (path.endsWith("/transactions")) {
      return json(200, { range, transactions: mergeEnrichments(txns, enr) });
    }
    if (path.endsWith("/accounts")) {
      return json(200, { accounts: await ledger.listAccounts(tenantId) });
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
