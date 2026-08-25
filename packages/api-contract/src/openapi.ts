/**
 * Generate the OpenAPI document from the Zod definitions.
 *
 * Generated, never written. A hand-maintained OpenAPI file is exactly the
 * "hand-maintained pair that drifts" CONTRIBUTING forbids — it would drift in a
 * new file format, and the drift would be invisible until a generated client
 * disagreed with the server. See #26.
 *
 * The output is checked in and snapshot-tested. A snapshot is a change
 * detector, not a correctness check, which is what is wanted here: it cannot
 * say the contract is good, only that it differs from last week — and it makes
 * a breaking change visible in a diff rather than in a client that has shipped.
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import {
  AccountView,
  AccountsResponse,
  BacklogResponse,
  BalancePoint,
  BalancesResponse,
  Cadence,
  CategoryTallyView,
  CategoryTotal,
  ChangeView,
  ConflictView,
  ContributionView,
  DateRange,
  DescriptionView,
  EffectView,
  GapView,
  IntroducedConflictView,
  Count,
  IsoDate,
  MatcherView,
  MonthTotal,
  PredictionView,
  ProposalRequest,
  ProposalResponse,
  ProposedRuleSetView,
  Provisional,
  RecurrenceView,
  RuleView,
  Summary,
  TransactionView,
  TransactionsResponse,
} from "./index.js";
import {
  API_VERSION,
  CATEGORISATION_ROUTES,
  COMPATIBILITY_PROMISE,
  ROUTES,
  pathFor,
  type Route,
} from "./routes.js";

/**
 * Every shape that gets a name in the document.
 *
 * Generated in one pass rather than once per response, so a shape used by two
 * responses becomes one component that both `$ref`. Generating per response
 * inlines the shared shapes into each, and a client generator then produces
 * three structurally identical structs with three different names — which is
 * how a "contract" starts describing the same thing more than once again.
 */
const NAMED = {
  // The leaf helpers are named too. Left unnamed they are deduplicated into a
  // `$ref` pointing *into* another schema's properties —
  // `#/components/schemas/DateRange/properties/from` — which resolves as a JSON
  // pointer but is not a Schema Object, and client generators reject it. That
  // would have surfaced as a build failure in the iOS repository rather than
  // here.
  IsoDate,
  Count,
  Provisional,
  DateRange,
  CategoryTotal,
  MonthTotal,
  TransactionView,
  AccountView,
  Summary,
  TransactionsResponse,
  AccountsResponse,
  BalancePoint,
  BalancesResponse,
  // Categorisation. Named for the same reason as the leaves above: unnamed,
  // a shape used by two responses is inlined into each, and a client generator
  // produces several structurally identical structs with different names.
  CategoryTallyView,
  DescriptionView,
  Cadence,
  RecurrenceView,
  GapView,
  ConflictView,
  BacklogResponse,
  MatcherView,
  ContributionView,
  RuleView,
  ProposedRuleSetView,
  ProposalRequest,
  ChangeView,
  EffectView,
  IntroducedConflictView,
  PredictionView,
  ProposalResponse,
} as const;

/**
 * OpenAPI 3.0.3, because that is the dialect the generator emits natively.
 *
 * 3.1 is the tidier specification — its schema dialect *is* JSON Schema, where
 * 3.0 has a near-JSON-Schema of its own. But `zod-to-json-schema` has no
 * 2020-12 target, so producing 3.1 would mean emitting 2019-09 and hand-fixing
 * the differences on the way out. That translation step is precisely what this
 * issue exists to remove: a hand-maintained conversion is a hand-maintained
 * copy, and it would drift silently because nothing compares the two dialects.
 *
 * The practical difference is nullability — 3.0 spells it `nullable: true`,
 * which the `openApi3` target produces correctly for `Summary.currency`. Swift
 * client generation supports 3.0 and 3.1 alike, so nothing downstream loses.
 */
const OPENAPI_VERSION = "3.0.3";

/** Where the schemas live in the document, and what `$ref` must point at. */
const DEFS = "components/schemas";

function allSchemas(): Record<string, unknown> {
  // A trivial root: everything wanted is in `definitions`, and the root itself
  // is discarded. zod-to-json-schema has no "just emit these" entry point.
  const out = zodToJsonSchema(z.object({}), {
    definitions: NAMED as unknown as Record<string, z.ZodTypeAny>,
    $refStrategy: "root",
    // basePath + definitionPath together decide what a `$ref` looks like. The
    // default appends "definitions", which produced
    // `#/components/schemas/definitions/AccountView` — a path to nothing, and
    // the kind of break a generated client hits at build time rather than a
    // test catching. The snapshot below pins the resolved refs.
    basePath: ["#", "components"],
    definitionPath: "schemas",
    target: "openApi3",
  }) as { schemas?: Record<string, unknown> };
  return schemasFrom(out);
}

/**
 * Pull the named schemas out of what the generator returned.
 *
 * Separate and exported so both sides are testable. Inline, the empty branch
 * was unreachable from any test and would have gone unnoticed if the option
 * names ever changed under us — the document would then generate with no
 * components at all, every `$ref` would dangle, and the snapshot would happily
 * record the wreckage as the new expected output.
 */
export function schemasFrom(out: { schemas?: Record<string, unknown> }): Record<string, unknown> {
  return out.schemas ?? {};
}

function parametersFor(route: Route): unknown[] {
  return route.query.map((p) => ({
    name: p.name,
    in: "query",
    required: p.required,
    description: p.description,
    schema: zodToJsonSchema(p.schema, { target: "openApi3", $refStrategy: "none" }),
  }));
}

/**
 * A method name a client generator can use.
 *
 * Segments are joined rather than left as slashes: `/categorisation/gaps` has to
 * become one identifier, and a generator handed `categorisation/gaps` produces
 * either a syntax error or something it invented, neither of which is stable
 * across runs. Single-segment paths are unchanged, so the existing operation
 * names — and the document snapshot — stay exactly as they were.
 */
function operationIdFor(route: Route): string {
  const [first, ...rest] = route.path.replace(/^\//, "").split("/");
  return [first, ...rest.map((s) => s.charAt(0).toUpperCase() + s.slice(1))].join("");
}

/**
 * The request body, for the routes that take one.
 *
 * Spread into the operation rather than set to undefined, because a
 * `requestBody: undefined` key survives `JSON.stringify` in some shapes and a
 * GET that advertises an empty body is a lie a generated client will act on.
 */
function requestBodyFor(route: Route): Record<string, unknown> {
  if (!route.request) return {};
  return {
    requestBody: {
      required: true,
      content: { "application/json": { schema: { $ref: `#/${DEFS}/${route.request.name}` } } },
    },
  };
}

export interface OpenApiDocument {
  openapi: string;
  info: Record<string, unknown>;
  servers: unknown[];
  security: unknown[];
  components: Record<string, unknown>;
  paths: Record<string, unknown>;
}

/**
 * Build the document.
 *
 * Takes the routes rather than reaching for `ROUTES`, so that generation can be
 * tested against a route shape the published set does not contain yet — a
 * request body has to be provably right before an endpoint depends on it, not
 * after. The default is the real set, so every caller is unaffected.
 */
export function buildOpenApiDocument(
  routes: readonly Route[] = [...ROUTES, ...CATEGORISATION_ROUTES],
): OpenApiDocument {
  const schemas = allSchemas();
  const paths: Record<string, unknown> = {};

  for (const route of routes) {
    paths[pathFor(route)] = {
      [route.method]: {
        // Stable and derived from the path, so a client generator produces the
        // same method names every run rather than renumbering on reorder.
        operationId: operationIdFor(route),
        summary: route.summary,
        description: route.description,
        parameters: parametersFor(route),
        ...requestBodyFor(route),
        responses: {
          "200": {
            description: route.summary,
            content: {
              "application/json": {
                schema: { $ref: `#/${DEFS}/${route.response.name}` },
              },
            },
          },
          "400": { description: "The range is missing, malformed, or `from` is after `to`" },
          "401": { description: "No bearer token, or one this API does not trust" },
          "403": { description: "A valid token carrying no household claim" },
        },
      },
    };
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: "Tightarse",
      version: API_VERSION,
      description:
        "Read-only aggregation over one household's bank accounts.\n\n" +
        `Compatibility: ${COMPATIBILITY_PROMISE}\n\n` +
        "Money is always an integer in minor units (pence). Sign convention: " +
        "negative left the household, positive arrived — including on cards, " +
        "which the provider reports from the issuer's point of view and which " +
        "are normalised at the boundary.",
    },
    // Deliberately absent: the deployed URL. It differs per environment and
    // baking one in would ship a document that is wrong everywhere else.
    servers: [{ url: "{apiUrl}", variables: { apiUrl: { default: "https://example.invalid" } } }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            "A Cognito access token. The household is taken from a verified claim in the token " +
            "and never from the request, so there is no tenant parameter anywhere in this document.",
        },
      },
      schemas,
    },
    paths,
  };
}

/**
 * Serialised the one way, so the snapshot diffs on content rather than on key
 * order or indentation.
 */
export function renderOpenApiDocument(): string {
  return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
}
