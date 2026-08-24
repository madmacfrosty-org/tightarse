import { describe, it, expect, vi } from "vitest";
import { rangeFrom, route, tenantFrom, type CategorisationDeps } from "../src/categorisation.js";
import type { Backlog } from "@tightarse/domain";

/**
 * The signed categorisation route.
 *
 * A signed request carries an AWS principal and no household, so the tenant
 * comes from the environment. That is a different access-control model from the
 * dashboard's, and the tests that matter most here are the ones proving a
 * caller cannot reach into the other one — no query parameter, no header and no
 * body may decide whose ledger is read.
 */

const EMPTY: Backlog = { descriptions: [], recurrences: [], gaps: [], scanned: 0 };

const deps = (backlog: Backlog = EMPTY): CategorisationDeps & { seen: string[] } => {
  const seen: string[] = [];
  return {
    seen,
    inspection: {
      backlog: vi.fn(async (tenantId: string) => {
        seen.push(tenantId);
        return backlog;
      }),
    },
  };
};

const env = { TENANT_ID: "frost" } as unknown as NodeJS.ProcessEnv;
const event = (over: Record<string, unknown> = {}) => ({
  rawPath: "/v1/categorisation/gaps",
  queryStringParameters: { from: "2026-01-01", to: "2026-12-31" },
  ...over,
});
const body = (res: { body: string }) => JSON.parse(res.body) as Record<string, unknown>;

describe("whose ledger is read", () => {
  it("takes the household from the environment", () => {
    expect(tenantFrom(env)).toBe("frost");
  });

  it("refuses to serve anything when no household is configured", () => {
    expect(() => tenantFrom({} as NodeJS.ProcessEnv)).toThrow(/No household configured/);
    expect(() => tenantFrom({ TENANT_ID: "" } as unknown as NodeJS.ProcessEnv)).toThrow();
  });

  it("ignores a household named in the request", async () => {
    // The single most important line in this file. A signed principal says
    // nothing about whose ledger it may read, so the request must not either.
    const d = deps();
    await route(d, event({ queryStringParameters: { from: "2026-01-01", to: "2026-12-31", tenantId: "someone-else" } }), env);

    expect(d.seen).toEqual(["frost"]);
  });

  it("answers 500 without saying why when the household is missing", async () => {
    const res = await route(deps(), event(), {} as NodeJS.ProcessEnv);

    expect(res.statusCode).toBe(500);
    expect(body(res)).toEqual({ error: "Internal error" });
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
      scanned: 4,
    };
    const res = await route(deps(backlog), event(), env);

    expect(res.statusCode).toBe(200);
    expect(body(res)).toMatchObject({
      range: { from: "2026-01-01", to: "2026-12-31" },
      scanned: 4,
      gaps: [{ description: "UNKNOWN SHOP", transactions: 1, outgoing: 10_00 }],
    });
  });

  it("answers 400 for a bad range without reaching the ledger", async () => {
    const d = deps();
    const res = await route(d, event({ queryStringParameters: {} }), env);

    expect(res.statusCode).toBe(400);
    expect(d.seen).toEqual([]);
  });

  it("answers 400, not 500, for a range that runs backwards", async () => {
    // The status has to survive the throw. Losing it turns a caller's mistake
    // into what looks like a server fault, and hides the message that says so.
    const res = await route(deps(), event({ queryStringParameters: { from: "2026-12-31", to: "2026-01-01" } }), env);

    expect(res.statusCode).toBe(400);
    expect(body(res)["error"]).toMatch(/after/);
  });

  it("answers 404 for a path it does not serve", async () => {
    const res = await route(deps(), event({ rawPath: "/v1/categorisation/nope" }), env);

    expect(res.statusCode).toBe(404);
    expect(body(res)["error"]).toContain("/v1/categorisation/nope");
  });

  it("treats a missing path as unroutable rather than as the default route", async () => {
    const res = await route(deps(), event({ rawPath: undefined }), env);

    expect(res.statusCode).toBe(404);
    expect(body(res)["error"]).toBe("No route for /");
  });

  it("never echoes an underlying failure, which can carry table structure", async () => {
    const failing: CategorisationDeps = {
      inspection: { backlog: vi.fn(async () => { throw new Error("ResourceNotFoundException: table Ledger-prod"); }) },
    };
    const res = await route(failing, event(), env);

    expect(res.statusCode).toBe(500);
    expect(body(res)).toEqual({ error: "Internal error" });
  });

  it("survives something thrown that is not an Error", async () => {
    // A rejected promise can carry anything. Reaching for `.message` on a
    // string would throw inside the catch and turn a handled failure into a
    // 502 with no body at all.
    const failing: CategorisationDeps = {
      inspection: { backlog: vi.fn(async () => { throw { statusCode: 400, detail: "not an Error" }; }) },
    };
    const res = await route(failing, event(), env);

    expect(res.statusCode).toBe(400);
    expect(body(res)).toEqual({ error: "Unknown error" });
  });

  it("says it is JSON", async () => {
    expect((await route(deps(), event(), env)).headers).toEqual({ "content-type": "application/json" });
  });
});

describe("the entry point", () => {
  it("binds the use case to a real store rather than returning a placeholder", async () => {
    // Only the entry point may run a constructor, so nothing else covers it.
    const { realDeps } = await import("../src/categorisation.js");

    expect(realDeps().inspection).toEqual(expect.objectContaining({ backlog: expect.any(Function) }));
  });

  it("answers rather than throwing when the household is not configured", async () => {
    // The Lambda's own entry, which builds its dependencies on first call. A
    // throw here is a 502 with no body; the handler owes a JSON answer.
    const { handler } = await import("../src/categorisation.js");
    const saved = process.env["TENANT_ID"];
    delete process.env["TENANT_ID"];
    try {
      const res = await handler({ rawPath: "/v1/categorisation/gaps", queryStringParameters: {} });
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: "Internal error" });
    } finally {
      if (saved !== undefined) process.env["TENANT_ID"] = saved;
    }
  });
});
