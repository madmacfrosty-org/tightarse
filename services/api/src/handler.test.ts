import { describe, it, expect, vi, beforeEach } from "vitest";
import { handler, ledgerConfig, route, realDeps, type ApiDeps } from "./handler.js";

/**
 * The routing was unreachable until the ledger client became an argument: it
 * sat behind a constructor needing a table name and a region, so none of this
 * — including the tenant rule, which is the whole access-control model — had a
 * single test.
 */

const listRange = vi.fn();
const listAccounts = vi.fn();
const deps: ApiDeps = { ledger: { listRange, listAccounts } };

const event = (over: Record<string, unknown> = {}) => ({
  rawPath: "/summary",
  requestContext: { authorizer: { jwt: { claims: { "custom:tenant": "frost" } } } },
  ...over,
});

const body = (res: { body: string }) => JSON.parse(res.body) as Record<string, unknown>;

beforeEach(() => {
  listRange.mockReset().mockResolvedValue({ transactions: [], enrichments: [] });
  listAccounts.mockReset().mockResolvedValue([]);
});

describe("who the caller is allowed to read", () => {
  it("takes the household from the verified claim and never from the request", async () => {
    // A query parameter would let any authenticated household read any other's
    // ledger. This is the single most important behaviour in the service.
    await route(deps, event({ queryStringParameters: { tenantId: "somebody-else" } }) as never);
    expect(listRange).toHaveBeenCalledWith("frost", expect.anything());
  });

  it("refuses an identity carrying no household, rather than defaulting to one", async () => {
    // Falling back to a default tenant would hand a stranger somebody's ledger.
    const res = await route(deps, event({ requestContext: { authorizer: { jwt: { claims: {} } } } }) as never);
    expect(res.statusCode).toBe(403);
    expect(listRange).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated request", async () => {
    const res = await route(deps, event({ requestContext: undefined }) as never);
    expect(res.statusCode).toBe(403);
    expect(listRange).not.toHaveBeenCalled();
  });

  it("refuses a household claim that is present but empty", async () => {
    const claims = { "custom:tenant": "" };
    const res = await route(deps, event({ requestContext: { authorizer: { jwt: { claims } } } }) as never);
    expect(res.statusCode).toBe(403);
  });
});

describe("the range a request may ask for", () => {
  it("bounds an unqualified request to a rolling year rather than all history", async () => {
    // Without a default, an unqualified request pulls five years across the
    // wire on every dashboard load.
    // Pinned. Without fake timers this asserted today's date against today's
    // date and would have started failing tomorrow.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T09:00:00Z"));
    await route(deps, event() as never);
    expect(listRange).toHaveBeenCalledWith("frost", { from: "2025-03-10", to: "2026-03-10" });
    vi.useRealTimers();
  });

  it("rejects a backwards range instead of quietly returning nothing", async () => {
    // An empty result reads as "no transactions", which is indistinguishable
    // from a broken sync.
    const res = await route(deps, event({ queryStringParameters: { from: "2026-05-01", to: "2026-01-01" } }) as never);
    expect(res.statusCode).toBe(400);
    expect(listRange).not.toHaveBeenCalled();
  });

  it("accepts a range whose ends are equal, which is a single day", async () => {
    const res = await route(deps, event({ queryStringParameters: { from: "2026-05-01", to: "2026-05-01" } }) as never);
    expect(res.statusCode).toBe(200);
  });
});

describe("routing", () => {
  it("answers /accounts from the account list, not the range query", async () => {
    listAccounts.mockResolvedValue([{ accountId: "a1" }]);
    const res = await route(deps, event({ rawPath: "/v1/accounts" }) as never);
    expect(body(res)["accounts"]).toEqual([{ accountId: "a1" }]);
  });

  it("answers /transactions with the enrichment merged onto each row", async () => {
    // The category comes from a separate enrichment row keyed to the
    // transaction. Returning the transactions unmerged loses every category on
    // the page while still looking like a successful response.
    listRange.mockResolvedValue({
      transactions: [
        {
          dedupKey: "k1",
          tenantId: "frost",
          accountId: "a1",
          timestamp: "2026-03-15T00:00:00Z",
          amount: -1299,
          description: "SHOP",
        },
      ],
      enrichments: [{ dedupKey: "k1", category: "Groceries" }],
    });
    const res = await route(deps, event({ rawPath: "/v1/transactions" }) as never);
    const rows = body(res)["transactions"] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!["category"]).toBe("Groceries");
  });

  it("returns the range it actually used alongside the transactions", async () => {
    // The dashboard labels its charts with this. Echoing something other than
    // the range that was queried mislabels every chart on the page.
    const res = await route(
      deps,
      event({ rawPath: "/v1/transactions", queryStringParameters: { from: "2026-01-01", to: "2026-02-01" } }) as never,
    );
    expect(body(res)["range"]).toEqual({ from: "2026-01-01", to: "2026-02-01" });
  });

  it("404s an unknown path rather than falling through to a summary", async () => {
    const res = await route(deps, event({ rawPath: "/v1/nonsense" }) as never);
    expect(res.statusCode).toBe(404);
  });
});

describe("what a failure tells the caller", () => {
  it("does not echo an internal error, which can carry table structure", async () => {
    listRange.mockRejectedValue(new Error("ResourceNotFound: table tightarse-prod-Ledger"));
    const res = await route(deps, event() as never);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("tightarse-prod-Ledger");
    expect(body(res)["error"]).toBe("Internal error");
  });

  it("does explain a 4xx, which is the caller's own mistake", async () => {
    const res = await route(deps, event({ queryStringParameters: { from: "2026-05-01", to: "2026-01-01" } }) as never);
    expect(body(res)["error"]).toMatch(/after/);
  });
});

describe("building the real dependencies", () => {
  it("constructs a ledger client rather than returning a placeholder", () => {
    // Only the entry point may run a constructor, so nothing else covers it.
    expect(realDeps().ledger).toHaveProperty("listRange");
  });
});

describe("the Lambda entry point", () => {
  it("wires the real dependencies through to the routing", async () => {
    // Exercises the entry point, which nothing else reaches: it builds a real
    // Ledger and delegates. The 403 path returns before any call is made, so
    // this constructs a client and touches no network.
    const res = await handler(event({ requestContext: undefined }) as never);
    expect(res.statusCode).toBe(403);
  });
});

describe("where the ledger client points", () => {
  it("uses the table and region the environment gives it", () => {
    expect(ledgerConfig({ TABLE_NAME: "tightarse-dev-Ledger", AWS_REGION: "eu-west-2" })).toEqual({
      tableName: "tightarse-dev-Ledger",
      region: "eu-west-2",
    });
  });

  it("falls back to the deployed region when AWS_REGION is unset", () => {
    // Set in CI and in Lambda, unset on a laptop. Both sides are asserted here
    // so branch coverage does not depend on which machine ran the suite.
    expect(ledgerConfig({ TABLE_NAME: "t" }).region).toBe("eu-west-1");
  });

  it("yields an empty table name rather than throwing when TABLE_NAME is unset", () => {
    // Deliberate: the Lambda would fail on first use with a DynamoDB error
    // naming the empty table, which is clearer than a module that will not load.
    expect(ledgerConfig({}).tableName).toBe("");
  });
});
