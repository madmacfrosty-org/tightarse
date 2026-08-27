import { NewCategoryRequest, ProposalRequest } from "@tightarse/api-contract";
import { DynamoStore } from "@tightarse/dynamodb";
import type { Commit, Inspection, ProposalDeps, ProposalOutcome, RuleSet } from "@tightarse/domain";
import { createCategory, inspection, proposeRules } from "@tightarse/domain";
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
  /** Adding a category, which has to exist before a rule may name it. */
  readonly addCategory: (
    tenantId: string,
    request: { label: string; kind?: "spending" | "income" | "movement" },
  ) => Promise<{ id: string; label: string; kind: string }>;
  /**
   * Proposing, which is a write.
   *
   * A separate member rather than the store, so a test drives the route without
   * a table and the composition stays in one place.
   */
  readonly propose: (
    tenantId: string,
    request: {
      sets?: readonly RuleSet[];
      merchant?: {
    term?: string | undefined;
    type?: string | undefined;
    min?: number | undefined;
    max?: number | undefined;
    category: string;
  };
      transactions?: { dedupKeys: readonly string[]; category: string };
      commit: Commit;
      by: string;
      now: Date;
      range: { from: string; to: string };
    },
  ) => Promise<ProposalOutcome>;
}

/**
 * How far the caller wants this taken.
 *
 * Defaults to `propose`, because POST to a collection creating a row is what a
 * caller expects, and one that means to propose, forgets a parameter and gets
 * silence is a worse failure than a row that can be rejected.
 *
 * Anything unrecognised is refused rather than defaulted. A typo silently
 * meaning "write and apply" is the wrong way round.
 */
export function commitFrom(event: HttpEvent): Commit {
  const asked = (event.queryStringParameters ?? {})["commit"];
  if (asked === undefined) return "propose";
  if (asked === "preview" || asked === "propose" || asked === "apply") return asked;
  throw Object.assign(new Error(`commit must be preview, propose or apply — not "${asked}"`), {
    statusCode: 400,
  });
}

/**
 * The proposed sets, from a body this route will not trust.
 *
 * Parsed against the contract rather than cast. A signed principal is
 * authorised, not correct, and a malformed set reaching the domain is a rule
 * that matches nothing or everything.
 */
/** The body, decoded and parsed, or a 400 saying which of those failed. */
function jsonBody(event: HttpEvent): unknown {
  if (!event.body) {
    throw Object.assign(new Error("A body is required"), { statusCode: 400 });
  }
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("Body is not JSON"), { statusCode: 400 });
  }
}

/**
 * Every malformed field, not just the first.
 *
 * A proposal with three bad rules should not take three round trips to correct.
 */
function badRequest(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): Error {
  const detail = issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
  return Object.assign(new Error(detail), { statusCode: 400 });
}

export function proposalFrom(event: HttpEvent): {
  sets?: readonly RuleSet[];
  merchant?: {
    term?: string | undefined;
    type?: string | undefined;
    min?: number | undefined;
    max?: number | undefined;
    category: string;
  };
  transactions?: { dedupKeys: readonly string[]; category: string };
} {
  const result = ProposalRequest.safeParse(jsonBody(event));
  if (!result.success) throw badRequest(result.error.issues);

  // Exactly one. Two is a caller that has not decided what it wants, none is a
  // proposal that proposes nothing, and building a rule from whichever happened
  // to be checked first is worse than refusing either.
  const given = [result.data.sets, result.data.merchant, result.data.transactions].filter(
    (x) => x !== undefined,
  );
  if (given.length !== 1) {
    throw Object.assign(new Error("give exactly one of sets, merchant or transactions"), {
      statusCode: 400,
    });
  }

  // Every condition on a merchant rule is optional, so none of them is a
  // request the schema accepts and the domain refuses. Refused here, where the
  // answer can say which parameter was missing rather than being a 500.
  const m = result.data.merchant;
  if (m && m.term === undefined && m.type === undefined && m.min === undefined && m.max === undefined) {
    throw Object.assign(new Error("a merchant rule needs a term, a type or an amount bound"), {
      statusCode: 400,
    });
  }

  // The wire shape and the domain's rule set are near-identities; the status and
  // the version are the domain's to decide, never the caller's.
  return {
    ...(result.data.sets === undefined
      ? {}
      : {
          sets: result.data.sets.map((set) => ({
            ...set,
            status: "proposed" as const,
            createdAt: new Date(0).toISOString(),
          })) as unknown as readonly RuleSet[],
        }),
    ...(result.data.merchant === undefined ? {} : { merchant: result.data.merchant }),
    ...(result.data.transactions === undefined ? {} : { transactions: result.data.transactions }),
  };
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

    if (path.endsWith("/categories")) {
      const body = jsonBody(event);
      const parsed = NewCategoryRequest.safeParse(body);
      if (!parsed.success) throw badRequest(parsed.error.issues);
      const added = await deps.addCategory(tenantId, parsed.data).catch((e: unknown) => {
        // A taken name is an answer, not a fault. Reported as a conflict with
        // the reason intact, because "internal error" hides the one sentence
        // that says to pick the existing category instead.
        if (e instanceof Error && e.name === "CategoryExists") {
          throw Object.assign(e, { statusCode: 409 });
        }
        throw e;
      });
      // 201: it made something, and the body is where to find it.
      return json(201, { id: added.id, label: added.label, kind: added.kind });
    }

    if (path.endsWith("/categorisation/proposals")) {
      const range = rangeFrom(event);
      const outcome = await deps.propose(tenantId, {
        ...proposalFrom(event),
        commit: commitFrom(event),
        // Provenance, from the same claim that authorised the request.
        by: tenantId,
        now: new Date(),
        range,
      });
      return json(200, asProposalResponse(outcome.prediction, outcome.proposed, outcome.applied));
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
  const deps: ProposalDeps = {
    transactions: store,
    ruleSets: store,
    categories: store,
    categorisations: store,
  };
  return {
    inspection: inspection({ transactions: store, ruleSets: store }),
    // Bound rather than wrapped, for the same reason as above: a wrapper here
    // is a function no test can reach without a table.
    addCategory: createCategory.bind(null, { categories: store }),
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
