import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildOpenApiDocument, renderOpenApiDocument, schemasFrom } from "../src/openapi";
import { API_VERSION, CONNECT_PATHS, ROUTES, pathFor } from "../src/routes";

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
    const onDisk = readFileSync(join(__dirname, "..", "openapi.json"), "utf8");
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
    expect(Object.keys(doc.paths).sort()).toEqual(ROUTES.map(pathFor).sort());
    for (const path of Object.keys(doc.paths)) {
      expect(path.startsWith(`/${API_VERSION}/`), `${path} is not versioned`).toBe(true);
    }
  });

  it("requires a bearer token on every route and takes no tenant parameter", () => {
    // The household comes from a verified claim and never from the request. A
    // documented tenant parameter would invite a client to send one, and the
    // first person to try it would be asking for somebody else's ledger.
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    const params = Object.values(doc.paths as Record<string, any>).flatMap(
      (p) => p.get.parameters as Array<{ name: string }>,
    );
    // The intent, not a count: a route may be added without touching this, but
    // a parameter naming a household may not. Counting them meant adding
    // /balances broke a test about tenancy, which is the wrong thing to notice.
    const names = new Set(params.map((p) => p.name));
    expect([...names].sort()).toEqual(["from", "to"]);
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
