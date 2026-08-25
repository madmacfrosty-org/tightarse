import { ProposalRequest } from "@tightarse/api-contract";
import { DynamoStore } from "@tightarse/dynamodb";
import type { Inspection, ProposalDeps, ProposalOutcome, RuleSet } from "@tightarse/domain";
import { inspection, proposeRules } from "@tightarse/domain";
import { ledgerConfig, tenantFrom } from "./handler.js";
import { asBacklog, asProposalResponse } from "./wire.js";

/**
 * The categorisation API.
 *
 * A second entry point and a second Lambda, but no longer a second access-control
 * model: the household comes from the verified `custom:tenant` claim, through the
 * same function every other route uses.
 *
 * It was signed with SigV4 and resolved the household from the environment, so a
 * model outside the account could drive it. That was the wrong trade. These
 * routes are the ones the dashboard needs, a browser has a bearer token and
 * cannot sign, and an API the product cannot call is not the API the product
 * needs. The offline path can hold a household token or use the CLIs, which
 * reach the table directly and always could.
 *
 * Still a separate function, for the reason that survives: this one writes.
 * The dashboard's stays read-only, so a bug in the reporting path cannot mutate
 * a ledger.
 */

interface HttpEvent {
  rawPath?: string;
  requestContext?: {
    http?: { method?: string };
    authorizer?: { jwt?: { claims?: Record<string, unknown> } };
  };
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

export async function route(deps: CategorisationDeps, event: HttpEvent) {
  try {
    const tenantId = tenantFrom(event);
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
        // Provenance, from the same claim that authorised the request.
        by: tenantId,
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
  return route(deps, event);
}
