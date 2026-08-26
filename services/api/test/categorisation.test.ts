import { describe, it, expect, vi } from "vitest";
import { commitFrom, rangeFrom, route, type CategorisationDeps } from "../src/categorisation.js";
import type { Backlog } from "@tightarse/domain";

/**
 * The signed categorisation route.
 *
 * Authorised by the same bearer token as everything else, and resolving the
 * household through the same shared function. The tests that matter most are
 * the ones proving nothing else can decide whose ledger is touched — no query
 * parameter, no header and no body.
 */

const EMPTY: Backlog = { descriptions: [], recurrences: [], gaps: [], conflicts: [], scanned: 0 };

const EMPTY_PREDICTION = {
  gained: EMPTY_EFFECT(),
  lost: EMPTY_EFFECT(),
  recategorised: EMPTY_EFFECT(),
  unchanged: EMPTY_EFFECT(),
  outranked: EMPTY_EFFECT(),
  introducedConflicts: [],
  scanned: 0,
};

function EMPTY_EFFECT() {
  return { transactions: 0, outgoing: 0, merchants: 0, entries: [] };
}

const deps = (backlog: Backlog = EMPTY): CategorisationDeps & { seen: string[]; proposals: unknown[] } => {
  const seen: string[] = [];
  const proposals: unknown[] = [];
  return {
    seen,
    proposals,
    inspection: {
      backlog: vi.fn(async (tenantId: string) => {
        seen.push(tenantId);
        return backlog;
      }),
    },
    propose: vi.fn(async (tenantId: string, request: unknown) => {
      seen.push(tenantId);
      proposals.push(request);
      return { prediction: EMPTY_PREDICTION };
    }),
  } as unknown as CategorisationDeps & { seen: string[]; proposals: unknown[] };
};

const event = (over: Record<string, unknown> = {}) => ({
  rawPath: "/v1/categorisation/gaps",
  requestContext: { authorizer: { jwt: { claims: { "custom:tenant": "frost" } } } },
  queryStringParameters: { from: "2026-01-01", to: "2026-12-31" },
  ...over,
});
const body = (res: { body: string }) => JSON.parse(res.body) as Record<string, unknown>;

describe("whose ledger is read", () => {
  it("takes the household from the verified claim", async () => {
    const d = deps();
    await route(d, event());

    expect(d.seen).toEqual(["frost"]);
  });

  it("ignores a household named in the request", async () => {
    // The single most important line in this codebase, and now shared with the
    // dashboard rather than written twice. A query parameter deciding whose
    // ledger is read is an authenticated user reading somebody else's.
    const d = deps();
    await route(
      d,
      event({ queryStringParameters: { from: "2026-01-01", to: "2026-12-31", tenantId: "someone-else" } }),
    );

    expect(d.seen).toEqual(["frost"]);
  });

  it("answers 403 for a token carrying no household", async () => {
    const res = await route(deps(), event({ requestContext: { authorizer: { jwt: { claims: {} } } } }));

    expect(res.statusCode).toBe(403);
    expect(body(res)["error"]).toContain("No household");
  });

  it("answers 403 when there is no verified claim at all", async () => {
    const res = await route(deps(), event({ requestContext: undefined }));

    expect(res.statusCode).toBe(403);
  });
});

describe("the range", () => {
  it("takes both ends from the query", () => {
    expect(rangeFrom(event())).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });

  it.each([
    ["from", { to: "2026-12-31" }],
    ["to", { from: "2026-01-01" }],
    ["both", {}],
  ])("refuses a request missing %s, rather than inventing one", (_which, q) => {
    expect(() => rangeFrom({ queryStringParameters: q })).toThrow(/both required/);
  });

  it("accepts a single day, where both ends are the same", () => {
    expect(rangeFrom({ queryStringParameters: { from: "2026-05-05", to: "2026-05-05" } })).toEqual({
      from: "2026-05-05",
      to: "2026-05-05",
    });
  });

  it("refuses a range that runs backwards", () => {
    expect(() => rangeFrom({ queryStringParameters: { from: "2026-12-31", to: "2026-01-01" } })).toThrow(/after/);
  });

  it("treats a missing query object as a missing range", () => {
    expect(() => rangeFrom({})).toThrow(/both required/);
  });
});

describe("routing", () => {
  it("serves the backlog, echoing the range it was asked for", async () => {
    const backlog: Backlog = {
      descriptions: [
        {
          description: "SOMEMART 118",
          transactions: 2,
          outgoing: 20_00,
          firstSeen: "2026-01-05T00:00:00.000Z",
          lastSeen: "2026-02-05T00:00:00.000Z",
          uncategorised: 1,
          categories: [{ category: "groceries", transactions: 1 }],
        },
      ],
      recurrences: [
        {
          amount: -95_00,
          cadence: "monthly",
          transactions: 3,
          outgoing: 285_00,
          descriptions: ["DD REF 1"],
          firstSeen: "2026-01-05T00:00:00.000Z",
          lastSeen: "2026-03-05T00:00:00.000Z",
          uncategorised: 3,
        },
      ],
      gaps: [{ description: "UNKNOWN SHOP", transactions: 1, outgoing: 10_00 }],
      conflicts: [{
    setId: "household",
    categories: ["groceries", "fuel"],
    rules: [0, 3],
    transactions: 4,
    example: "SOMEMART FORECOURT",
  }],
      scanned: 4,
    };
    const res = await route(deps(backlog), event());

    expect(res.statusCode).toBe(200);
    expect(body(res)).toMatchObject({
      range: { from: "2026-01-01", to: "2026-12-31" },
      scanned: 4,
      gaps: [{ description: "UNKNOWN SHOP", transactions: 1, outgoing: 10_00 }],
      conflicts: [{ setId: "household", categories: ["groceries", "fuel"], rules: [0, 3], transactions: 4, example: "SOMEMART FORECOURT" }],
    });
  });

  it("answers 400 for a bad range without reaching the ledger", async () => {
    const d = deps();
    const res = await route(d, event({ queryStringParameters: {} }));

    expect(res.statusCode).toBe(400);
    expect(d.seen).toEqual([]);
  });

  it("answers 400, not 500, for a range that runs backwards", async () => {
    // The status has to survive the throw. Losing it turns a caller's mistake
    // into what looks like a server fault, and hides the message that says so.
    const res = await route(deps(), event({ queryStringParameters: { from: "2026-12-31", to: "2026-01-01" } }));

    expect(res.statusCode).toBe(400);
    expect(body(res)["error"]).toMatch(/after/);
  });

  it("answers 404 for a path it does not serve", async () => {
    const res = await route(deps(), event({ rawPath: "/v1/categorisation/nope" }));

    expect(res.statusCode).toBe(404);
    expect(body(res)["error"]).toContain("/v1/categorisation/nope");
  });

  it("treats a missing path as unroutable rather than as the default route", async () => {
    const res = await route(deps(), event({ rawPath: undefined }));

    expect(res.statusCode).toBe(404);
    expect(body(res)["error"]).toBe("No route for /");
  });

  it("never echoes an underlying failure, which can carry table structure", async () => {
    const failing = {
      ...deps(),
      inspection: { backlog: vi.fn(async () => { throw new Error("ResourceNotFoundException: table Ledger-prod"); }) },
    } as unknown as CategorisationDeps;
    const res = await route(failing, event());

    expect(res.statusCode).toBe(500);
    expect(body(res)).toEqual({ error: "Internal error" });
  });

  it("survives something thrown that is not an Error", async () => {
    // A rejected promise can carry anything. Reaching for `.message` on a
    // string would throw inside the catch and turn a handled failure into a
    // 502 with no body at all.
    const failing = {
      ...deps(),
      inspection: { backlog: vi.fn(async () => { throw { statusCode: 400, detail: "not an Error" }; }) },
    } as unknown as CategorisationDeps;
    const res = await route(failing, event());

    expect(res.statusCode).toBe(400);
    expect(body(res)).toEqual({ error: "Unknown error" });
  });

  it("says it is JSON", async () => {
    expect((await route(deps(), event())).headers).toEqual({ "content-type": "application/json" });
  });
});

describe("the entry point", () => {
  it("binds the use case to a real store rather than returning a placeholder", async () => {
    // Only the entry point may run a constructor, so nothing else covers it.
    const { realDeps } = await import("../src/categorisation.js");

    expect(realDeps().inspection).toEqual(expect.objectContaining({ backlog: expect.any(Function) }));
  });

  it("answers rather than throwing when the token carries no household", async () => {
    // The Lambda's own entry, which builds its dependencies on first call. A
    // throw here is a 502 with no body; the handler owes a JSON answer.
    const { handler } = await import("../src/categorisation.js");
    const res = await handler({ rawPath: "/v1/categorisation/gaps", queryStringParameters: {} });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)["error"]).toContain("No household");
  });
});

describe("proposing a change", () => {
  const set = {
    setId: "household",
    version: 3,
    name: "household",
    order: 0,
    authored: true,
    rules: [
      {
        matcher: { kind: "merchant", pattern: "somemart" },
        contributes: { kind: "assert", category: "groceries" },
        appliesTo: "debits",
      },
    ],
  };
  const post = (over: Record<string, unknown> = {}) =>
    event({
      rawPath: "/v1/categorisation/proposals",
      body: JSON.stringify({ sets: [set] }),
      ...over,
    });

  it.each(["preview", "propose", "apply"])("takes commit=%s at its word", async (commit) => {
    const d = deps();
    await route(d, post({ queryStringParameters: { from: "2026-01-01", to: "2026-12-31", commit } }));

    expect(d.proposals[0]).toMatchObject({ commit });
  });

  it("proposes when nothing was asked for, rather than doing nothing", async () => {
    const d = deps();
    await route(d, post());

    expect(d.proposals[0]).toMatchObject({ commit: "propose" });
  });

  it("refuses a commit it does not recognise instead of guessing", async () => {
    // A typo quietly meaning "write and apply" is the wrong way round.
    const res = await route(
      deps(),
      post({ queryStringParameters: { from: "2026-01-01", to: "2026-12-31", commit: "aply" } }),
    );

    expect(res.statusCode).toBe(400);
    expect(body(res)["error"]).toContain("preview, propose or apply");
  });

  it("still takes the household from the claim, never the body", async () => {
    const d = deps();
    await route(d, post({ body: JSON.stringify({ sets: [set], tenantId: "someone-else" }) }));

    expect(d.seen).toEqual(["frost"]);
  });

  it("marks what it passes on as proposed, which is not the caller's to choose", async () => {
    const d = deps();
    await route(d, post());

    expect((d.proposals[0] as any).sets[0]).toMatchObject({ status: "proposed" });
  });

  it("answers 400 for a body that is not JSON", async () => {
    const res = await route(deps(), post({ body: "{oh dear" }));

    expect(res.statusCode).toBe(400);
    expect(body(res)["error"]).toBe("Body is not JSON");
  });

  it("answers 400 for a missing body rather than proposing nothing", async () => {
    const res = await route(deps(), post({ body: undefined }));

    expect(res.statusCode).toBe(400);
    expect(body(res)["error"]).toContain("needs a body");
  });

  it("names the field that was wrong, which is the difference between fixing and guessing", async () => {
    const res = await route(deps(), post({ body: JSON.stringify({ sets: [{ ...set, order: "first" }] }) }));

    expect(res.statusCode).toBe(400);
    expect(body(res)["error"]).toContain("sets.0.order");
  });

  it("refuses a proposal that proposes nothing", async () => {
    const res = await route(deps(), post({ body: JSON.stringify({ sets: [] }) }));

    expect(res.statusCode).toBe(400);
  });

  it.each([
    ["both sets and a merchant", { sets: [set], merchant: { term: "somemart", category: "groceries" } }],
    ["neither", { because: "no reason" }],
    ["all three", { sets: [set], merchant: { term: "x", category: "y" }, transactions: { dedupKeys: ["d"], category: "y" } }],
  ])("refuses a request giving %s", async (_case, payload) => {
    // Building a rule from whichever happened to be checked first is worse
    // than refusing either.
    const d = deps();
    const res = await route(d, post({ body: JSON.stringify(payload) }));

    expect(res.statusCode).toBe(400);
    expect(body(res)["error"]).toContain("exactly one");
    expect(d.proposals).toEqual([]);
  });

  it("takes a merchant term and passes it on unescaped, for the domain to handle", async () => {
    // The client says what it wants; escaping happens once, on the server, by
    // the same function that built the search which found the rows.
    const d = deps();
    await route(d, post({ body: JSON.stringify({ merchant: { term: "PIZZA (EXPRESS)", category: "eating-out" } }) }));

    expect(d.proposals[0]).toMatchObject({
      merchant: { term: "PIZZA (EXPRESS)", category: "eating-out" },
    });
  });

  it("takes named transactions", async () => {
    const d = deps();
    await route(d, post({ body: JSON.stringify({ transactions: { dedupKeys: ["a", "b"], category: "groceries" } }) }));

    expect(d.proposals[0]).toMatchObject({ transactions: { dedupKeys: ["a", "b"], category: "groceries" } });
  });

  it("refuses a matcher kind the domain does not have, rather than passing it on", async () => {
    const bad = { ...set, rules: [{ ...set.rules[0], matcher: { kind: "amount", value: 500 } }] };
    const res = await route(deps(), post({ body: JSON.stringify({ sets: [bad] }) }));

    expect(res.statusCode).toBe(400);
    expect(deps().proposals).toEqual([]);
  });

  it("reads a base64 body, which is what the gateway sends for some content types", async () => {
    const d = deps();
    const res = await route(
      d,
      post({ body: Buffer.from(JSON.stringify({ sets: [set] })).toString("base64"), isBase64Encoded: true }),
    );

    expect(res.statusCode).toBe(200);
    expect(d.proposals).toHaveLength(1);
  });

  it("measures against the range it was asked for", async () => {
    const d = deps();
    await route(d, post());

    expect(d.proposals[0]).toMatchObject({ range: { from: "2026-01-01", to: "2026-12-31" } });
  });

  it("refuses a proposal with no range, rather than inventing one", async () => {
    const res = await route(deps(), post({ queryStringParameters: {} }));

    expect(res.statusCode).toBe(400);
  });

  it("records who proposed it, from the same claim that authorised the request", async () => {
    const d = deps();
    await route(d, post());

    expect(d.proposals[0]).toMatchObject({ by: "frost" });
  });
});

describe("reading the commit mode on its own", () => {
  it("proposes when there is no query at all", () => {
    expect(commitFrom({})).toBe("propose");
  });

  it("says `body` when the whole payload is the wrong shape", async () => {
    // A JSON string is valid JSON and not a proposal. The issue has no path, so
    // there is no field to name and the message has to say so.
    const res = await route(
      deps(),
      event({ rawPath: "/v1/categorisation/proposals", body: JSON.stringify("hello") }),
    );

    expect(res.statusCode).toBe(400);
    expect(body(res)["error"]).toContain("body:");
  });

  it("reports every malformed field, not just the first", async () => {
    // Three bad rules should not take three round trips to correct.
    const broken = { setId: "household", version: -1, name: "", order: 0, authored: true, rules: [] };
    const res = await route(
      deps(),
      event({ rawPath: "/v1/categorisation/proposals", body: JSON.stringify({ sets: [broken] }) }),
    );

    expect(res.statusCode).toBe(400);
    expect(body(res)["error"]).toContain("sets.0.version");
    expect(body(res)["error"]).toContain("sets.0.name");
  });
});
