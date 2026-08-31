import { describe, it, expect } from "vitest";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument, renderOpenApiDocument, schemasFrom } from "../src/openapi.js";
import { API_VERSION, CATEGORISATION_ROUTES, CONNECT_PATHS, ROUTES, pathFor } from "../src/routes.js";

const doc = buildOpenApiDocument();
const text = JSON.stringify(doc);

/**
 * The checked-in document must match what the generator produces now.
 *
 * This is the change detector #26 asks for. It cannot say the contract is
 * good — only that it differs from the last time somebody looked — which is
 * exactly the right instrument here: a breaking change becomes a diff in review
 * instead of a bug report from a client that has already shipped.
 */
describe("the checked-in document", () => {
  it("is what the generator produces", () => {
    const onDisk = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "openapi.json"), "utf8");
    expect(onDisk).toBe(renderOpenApiDocument());
  });
});

/**
 * Structural checks, which a snapshot cannot make.
 *
 * A snapshot fails on *any* change and says nothing about which ones matter. It
 * would go green on a regenerated file that had quietly lost every money
 * annotation, because the new file is now the expected one. These say what must
 * remain true regardless of what else moves.
 */
describe("what must survive generation", () => {
  it("keeps the minor-units annotation on every monetary field", () => {
    // The whole reason this document exists is a client in another language. A
    // monetary field arriving in a generated Swift struct as a bare number,
    // with the unit lost in the pipeline, is worse than no generated client:
    // every figure on every screen is then wrong by a factor of 100 and looks
    // plausible. #26 names this as the thing to watch.
    const money = [
      ["Summary", "income"],
      ["Summary", "spend"],
      ["Summary", "net"],
      ["Summary", "transferTotal"],
      ["CategoryTotal", "total"],
      ["MonthTotal", "income"],
      ["MonthTotal", "spend"],
      ["MonthTotal", "net"],
      ["TransactionView", "amount"],
      ["AccountView", "currentBalance"],
      ["AccountView", "availableBalance"],
    ] as const;

    const schemas = doc.components["schemas"] as Record<string, any>;
    for (const [schema, field] of money) {
      const prop = schemas[schema]?.properties?.[field];
      expect(prop, `${schema}.${field} is missing from the document`).toBeDefined();
      expect(prop.description, `${schema}.${field} lost its units`).toMatch(/minor units \(pence\)/);
      // Integer, not number: a client that parses these as decimals is wrong.
      expect(prop.type, `${schema}.${field} is not an integer`).toBe("integer");
    }
  });

  it("says which way the money points, where the sign is not obvious", () => {
    // The one convention this repository has already lost five years of ledger
    // to. It has to travel in the contract, not in a comment beside it.
    const schemas = doc.components["schemas"] as Record<string, any>;
    expect(schemas["TransactionView"].properties.amount.description).toMatch(/Negative left the household/);
    expect(doc.info["description"]).toMatch(/negative left the household, positive arrived/i);
  });

  it("resolves every $ref to a component that exists", () => {
    // A ref into another schema's properties resolves as a JSON pointer and is
    // not a Schema Object. Generators reject it, and the failure would appear
    // in the iOS build rather than here.
    const names = Object.keys(doc.components["schemas"] as Record<string, unknown>);
    const refs = [...text.matchAll(/"\$ref":"([^"]+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref, `${ref} is not a plain component reference`).toMatch(/^#\/components\/schemas\/[^/]+$/);
      expect(names, `${ref} points at nothing`).toContain(ref.split("/").pop());
    }
  });

  it("serves every route under the version prefix, and none without it", () => {
    // #27. An unversioned path served by accident is one that has to be
    // supported for ever the moment something calls it.
    // `/v1/categories` is both a read and a write, served by different
    // functions, so the two lists overlap on the path and the document holds
    // one entry with two operations.
    expect(new Set(Object.keys(doc.paths))).toEqual(
      new Set([...ROUTES, ...CATEGORISATION_ROUTES].map(pathFor)),
    );
    for (const path of Object.keys(doc.paths)) {
      expect(path.startsWith(`/${API_VERSION}/`), `${path} is not versioned`).toBe(true);
    }
  });

  it("requires a bearer token on every route and takes no tenant parameter", () => {
    // The household comes from a verified claim and never from the request. A
    // documented tenant parameter would invite a client to send one, and the
    // first person to try it would be asking for somebody else's ledger.
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    // Every operation, whatever its verb — a POST that took a tenant parameter
    // would be just as wrong as a GET that did, and reading only `.get` stopped
    // looking the moment the first POST was published.
    const params = Object.values(doc.paths as Record<string, any>).flatMap((path) =>
      Object.values(path).flatMap((op: any) => (op.parameters ?? []) as Array<{ name: string }>),
    );
    // The intent, not a count: a route may be added without touching this, but
    // a parameter naming a household may not. Counting them meant adding
    // /balances broke a test about tenancy, which is the wrong thing to notice.
    const names = new Set(params.map((p) => p.name));
    expect([...names].sort()).toEqual(["commit", "from", "max", "min", "q", "to", "type"]);
  });

  it("documents no limit parameter", () => {
    // #28: the API never honoured one. Publishing it would promise a capability
    // nothing implements to a client that cannot read the handler.
    expect(text).not.toMatch(/"name":"limit"/);
  });

  it("names each shape once, so a generated client gets one struct per shape", () => {
    // Generating per response inlines shared shapes into each, and a client
    // generator then emits three structurally identical types.
    const schemas = doc.components["schemas"] as Record<string, unknown>;
    const serialised = Object.entries(schemas).map(([k, v]) => [k, JSON.stringify(v)] as const);
    const byBody = new Map<string, string[]>();
    for (const [name, body] of serialised) byBody.set(body, [...(byBody.get(body) ?? []), name]);
    const duplicated = [...byBody.values()].filter((names) => names.length > 1);
    expect(duplicated, `identical schemas under different names: ${JSON.stringify(duplicated)}`).toEqual([]);
  });
});

describe("paths", () => {
  it("versions a route and a bare string the same way", () => {
    // Both forms exist because the gateway maps over route objects and over the
    // connect paths, which are plain strings.
    expect(pathFor("/summary")).toBe(`/${API_VERSION}/summary`);
    expect(pathFor({ path: "/summary" })).toBe(pathFor("/summary"));
    for (const p of CONNECT_PATHS) expect(pathFor(p)).toBe(`/${API_VERSION}${p}`);
  });

  it("returns nothing rather than throwing when the generator produces no schemas", () => {
    // The branch that matters: if the generator's option names change under us
    // this returns empty, every $ref dangles, and the snapshot would record the
    // wreckage as the new expected output. Worth being explicit that the empty
    // case is reachable, so the assertion above about refs is what catches it.
    expect(schemasFrom({})).toEqual({});
    expect(schemasFrom({ schemas: { A: { type: "string" } } })).toEqual({ A: { type: "string" } });
  });
});

describe("routes that take a body", () => {
  const body = z.object({ sets: z.array(z.string()) });

  const post = {
    method: "post" as const,
    path: "/categorisation/proposals",
    summary: "Propose a change",
    description: "Computes what it would do, and writes it unless asked not to.",
    query: [],
    request: { name: "ProposalRequest", schema: body },
    response: { name: "ProposalResponse", schema: z.object({ ok: z.boolean() }) },
  };

  const get = {
    method: "get" as const,
    path: "/summary",
    summary: "Totals",
    description: "Totals for a range.",
    query: [],
    response: { name: "Summary", schema: z.object({ ok: z.boolean() }) },
  };

  it("describes the request body, because a caller guessing at the input gets it wrong silently", () => {
    const op = (buildOpenApiDocument([post]).paths["/v1/categorisation/proposals"] as any).post;

    expect(op.requestBody).toEqual({
      required: true,
      content: { "application/json": { schema: { $ref: "#/components/schemas/ProposalRequest" } } },
    });
  });

  it("gives a GET no request body at all, not an empty one", () => {
    // A key present and undefined survives some serialisations, and a GET that
    // advertises a body is a lie a generated client will act on.
    const op = (buildOpenApiDocument([get]).paths["/v1/summary"] as any).get;

    expect("requestBody" in op).toBe(false);
  });

  it("joins a nested path into one operation id a generator can use", () => {
    const op = (buildOpenApiDocument([post]).paths["/v1/categorisation/proposals"] as any).post;

    // Prefixed with the verb, because ids must be unique across the document
    // and a path can carry both a read and a write.
    expect(op.operationId).toBe("postCategorisationProposals");
  });

  it("keeps every GET id bare, since those are already published", () => {
    // A generated client's method names are a promise to whatever installed it.
    const ids = Object.values(buildOpenApiDocument().paths as Record<string, Record<string, { operationId: string }>>)
      .flatMap((ops) => Object.entries(ops))
      .filter(([method]) => method === "get")
      .map(([, op]) => op.operationId);

    expect(ids.sort()).toEqual(["accounts", "balances", "categories", "categorisationGaps", "diagnosticsRunningBalance", "summary", "transactions"]);
  });

  it("gives every operation in the document a distinct id", () => {
    const ids = Object.values(buildOpenApiDocument().paths as Record<string, Record<string, { operationId: string }>>)
      .flatMap((ops) => Object.values(ops))
      .map((op) => op.operationId);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("leaves a single-segment operation id exactly as it was", () => {
    // The published document's names are a promise to installed clients, so the
    // change above must be invisible to every route that exists today.
    const op = (buildOpenApiDocument([get]).paths["/v1/summary"] as any).get;

    expect(op.operationId).toBe("summary");
  });

  it("still builds the real document when given nothing", () => {
    expect(Object.keys(buildOpenApiDocument().paths)).toContain("/v1/summary");
  });
});

describe("the published routes themselves", () => {
  /**
   * Spelled out rather than derived. Building the expectation from ROUTES would
   * pass whatever ROUTES happened to say, which is the failure this is here to
   * catch: these are a promise to clients already installed, and a path,
   * method or response name that changes silently breaks a build in another
   * repository rather than in this one.
   */
  const PUBLISHED = [
    ["get", "/summary", "Summary", ["from", "to"]],
    ["get", "/transactions", "TransactionsResponse", ["from", "to", "q", "type", "min", "max"]],
    ["get", "/balances", "BalancesResponse", ["from", "to"]],
    ["get", "/diagnostics/running-balance", "RunningBalanceResponse", []],
    ["get", "/categories", "CategoriesResponse", []],
    ["get", "/accounts", "AccountsResponse", []],
  ] as const;

  it("publishes exactly these, in this order", () => {
    expect(ROUTES.map((r) => r.path)).toEqual(PUBLISHED.map(([, path]) => path));
  });

  it.each(PUBLISHED)("%s %s answers with %s", (method, path, response, query) => {
    const route = ROUTES.find((r) => r.path === path);

    expect(route, `no route for ${path}`).toBeDefined();
    expect(route!.method).toBe(method);
    expect(route!.response.name).toBe(response);
    expect(route!.query.map((q) => q.name)).toEqual([...query]);
    expect(route!.summary.length).toBeGreaterThan(0);
    expect(route!.description.length).toBeGreaterThan(0);
  });

  it("takes no request body on any of them, because they are all reads", () => {
    for (const route of ROUTES) expect(route.request).toBeUndefined();
  });

  it("requires both ends of every range it accepts", () => {
    // A defaulted range makes "no range" mean whatever the server felt like
    // that day, and a client cannot tell a defaulted answer from an answer.
    // Narrowing parameters are a different thing: absent means "do not narrow",
    // which is unambiguous.
    const NARROWING = new Set(["q", "type", "min", "max", "commit"]);
    for (const route of [...ROUTES, ...CATEGORISATION_ROUTES]) {
      for (const param of route.query) {
        expect(param.required, `${route.path} ${param.name}`).toBe(!NARROWING.has(param.name));
      }
    }
  });
});

describe("a path served two ways", () => {
  it("keeps both operations rather than the last one written", () => {
    // `/categories` is a read on the dashboard's function and a write on the
    // categorisation one. Assigning by path dropped the first silently, and the
    // published document said the endpoint only accepted a POST — a generated
    // client could not have listed categories.
    const get = {
      method: "get" as const,
      path: "/thing",
      summary: "Read",
      description: "Reads.",
      query: [],
      response: { name: "A", schema: z.object({ ok: z.boolean() }) },
    };
    const post = { ...get, method: "post" as const, summary: "Write", description: "Writes." };

    const built = buildOpenApiDocument([get, post]).paths["/v1/thing"] as Record<string, unknown>;

    expect(Object.keys(built).sort()).toEqual(["get", "post"]);
  });

  it("gives each operation its own id, or a generator produces one method twice", () => {
    const get = {
      method: "get" as const,
      path: "/categories",
      summary: "Read",
      description: "Reads.",
      query: [],
      response: { name: "A", schema: z.object({ ok: z.boolean() }) },
    };
    const post = { ...get, method: "post" as const };
    const built = buildOpenApiDocument([get, post]).paths["/v1/categories"] as Record<string, { operationId: string }>;

    expect(built["get"]!.operationId).not.toBe(built["post"]!.operationId);
  });
});
