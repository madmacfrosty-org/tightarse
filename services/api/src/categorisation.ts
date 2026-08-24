import { DynamoStore } from "@tightarse/dynamodb";
import type { Inspection } from "@tightarse/domain";
import { inspection } from "@tightarse/domain";
import { ledgerConfig } from "./handler.js";
import { asBacklog } from "./wire.js";

/**
 * The categorisation API, behind SigV4.
 *
 * A second entry point rather than a branch in `handler.ts`, and a second Lambda
 * rather than a second route on the first, for two reasons that both matter.
 *
 * The household comes from the ENVIRONMENT here, not from a verified JWT claim,
 * because a signed request carries an AWS principal and no household. Those are
 * two different access-control models, and a single handler holding both would
 * be one mistake away from honouring an environment tenant on a bearer-token
 * route — which is the one thing `handler.ts` exists to prevent.
 *
 * And this one will need to write, when proposals land. The browser-facing API
 * is granted read only, deliberately, and widening it so that a categorisation
 * route can write would put a mutation path behind every GET the dashboard makes.
 */

interface HttpEvent {
  rawPath?: string;
  queryStringParameters?: Record<string, string | undefined> | null;
}

export interface CategorisationDeps {
  readonly inspection: Inspection;
}

/**
 * The household this deployment serves.
 *
 * From the environment and never from the request. A signed caller is an AWS
 * principal, which says nothing about whose ledger it may read — so the answer
 * is fixed at deploy time by the same value the scheduled categoriser uses,
 * rather than being something a caller can ask for.
 */
export function tenantFrom(env: NodeJS.ProcessEnv): string {
  const tenant = env["TENANT_ID"];
  if (typeof tenant !== "string" || tenant.length === 0) {
    throw Object.assign(new Error("No household configured"), { statusCode: 500 });
  }
  return tenant;
}

/**
 * Both ends, both required.
 *
 * No rolling default. The contract says required, and defaulting would make an
 * unqualified request mean whatever the server felt like that day — which
 * matters more here than on the dashboard, because the answer drives which
 * rules someone writes.
 */
export function rangeFrom(event: HttpEvent): { from: string; to: string } {
  const q = event.queryStringParameters ?? {};
  const from = q["from"];
  const to = q["to"];
  if (!from || !to) {
    throw Object.assign(new Error("`from` and `to` are both required"), { statusCode: 400 });
  }
  if (from > to) {
    throw Object.assign(new Error("`from` is after `to`"), { statusCode: 400 });
  }
  return { from, to };
}

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export async function route(deps: CategorisationDeps, event: HttpEvent, env: NodeJS.ProcessEnv) {
  try {
    const tenantId = tenantFrom(env);
    const path = event.rawPath ?? "/";

    if (path.endsWith("/categorisation/gaps")) {
      const range = rangeFrom(event);
      return json(200, asBacklog(range, await deps.inspection.backlog(tenantId, range)));
    }

    return json(404, { error: `No route for ${path}` });
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    const message = err instanceof Error ? err.message : "Unknown error";
    // Never echo the underlying error for a 500 — it can carry key material and
    // table structure.
    return json(statusCode, { error: statusCode === 500 ? "Internal error" : message });
  }
}

/** Built by the entry point below, and by nothing a test runs. */
export function realDeps(): CategorisationDeps {
  const store = new DynamoStore(ledgerConfig(process.env));
  return { inspection: inspection({ transactions: store, ruleSets: store }) };
}

let deps: CategorisationDeps | undefined;

export async function handler(event: HttpEvent) {
  deps ??= realDeps();
  return route(deps, event, process.env);
}
