import { ProposalRequest } from "@tightarse/api-contract";
import { DynamoStore } from "@tightarse/dynamodb";
import type { Inspection, ProposalDeps, ProposalOutcome, RuleSet } from "@tightarse/domain";
import { inspection, proposeRules } from "@tightarse/domain";
import { ledgerConfig } from "./handler.js";
import { asBacklog, asProposalResponse } from "./wire.js";

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
  requestContext?: { http?: { method?: string } };
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string | undefined;
  isBase64Encoded?: boolean;
}

export interface CategorisationDeps {
  readonly inspection: Inspection;
  /**
   * Proposing, which is a write.
   *
   * A separate member rather than the store, so a test drives the route without
   * a table and the composition stays in one place.
   */
  readonly propose: (
    tenantId: string,
    request: { sets: readonly RuleSet[]; dryRun: boolean; by: string; now: Date; range: { from: string; to: string } },
  ) => Promise<ProposalOutcome>;
}

/**
 * Who a signed caller is, for the record on the version.
 *
 * Not an identity check — the gateway already refused anything unsigned. This
 * is provenance: a stored proposal has to say where it came from, and "the
 * signed API" is more honest than a person's name that nobody typed.
 */
const PROPOSED_BY = "api";

/**
 * Writing is the default; a dry run is asked for.
 *
 * POST to a collection creating a row is what a caller expects, and a caller
 * that means to propose, forgets a flag and gets silence is a worse failure than
 * a row that can be rejected. Anything other than an explicit `true` writes.
 */
export function dryRunFrom(event: HttpEvent): boolean {
  return (event.queryStringParameters ?? {})["dryRun"] === "true";
}

/**
 * The proposed sets, from a body this route will not trust.
 *
 * Parsed against the contract rather than cast. A signed principal is
 * authorised, not correct, and a malformed set reaching the domain is a rule
 * that matches nothing or everything.
 */
export function proposalFrom(event: HttpEvent): readonly RuleSet[] {
  if (!event.body) {
    throw Object.assign(new Error("A proposal needs a body"), { statusCode: 400 });
  }
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("Body is not JSON"), { statusCode: 400 });
  }

  const result = ProposalRequest.safeParse(parsed);
  if (!result.success) {
    // Names the field, which is the difference between a caller fixing it and a
    // caller guessing. Every issue, because a proposal with three malformed
    // rules should not take three round trips to correct.
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    throw Object.assign(new Error(detail), { statusCode: 400 });
  }

  // The wire shape and the domain's rule set are near-identities; the status and
  // the version are the domain's to decide, never the caller's.
  return result.data.sets.map((set) => ({
    ...set,
    status: "proposed" as const,
    createdAt: new Date(0).toISOString(),
  })) as unknown as readonly RuleSet[];
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

    if (path.endsWith("/categorisation/proposals")) {
      const range = rangeFrom(event);
      const outcome = await deps.propose(tenantId, {
        sets: proposalFrom(event),
        dryRun: dryRunFrom(event),
        by: PROPOSED_BY,
        now: new Date(),
        range,
      });
      return json(200, asProposalResponse(outcome.prediction, outcome.proposed));
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
  const deps: ProposalDeps = { transactions: store, ruleSets: store, categories: store };
  return {
    inspection: inspection({ transactions: store, ruleSets: store }),
    // Bound rather than wrapped: a wrapper here is a function no test can reach
    // without a table, and an unreachable line in the composition root is how
    // the routing itself went untested before.
    propose: proposeRules.bind(null, deps),
  };
}

let deps: CategorisationDeps | undefined;

export async function handler(event: HttpEvent) {
  deps ??= realDeps();
  return route(deps, event, process.env);
}
