import { describe, it, expect, vi, beforeEach } from "vitest";
import { handler, ledgerConfig, route, realDeps, type ApiDeps } from "../src/handler.js";
import { reporting } from "@tightarse/domain";
import type { Reporting } from "@tightarse/domain";

/**
 * The routing was unreachable until the ledger client became an argument: it
 * sat behind a constructor needing a table name and a region, so none of this
 * — including the tenant rule, which is the whole access-control model — had a
 * single test.
 */

const listRange = vi.fn();
const listAccounts = vi.fn();
// Typed, because an inferred `never[]` makes any set a type error the moment
// a test needs one — which is exactly what happened.
const listRuleSets = vi.fn(async (): Promise<Record<string, unknown>[]> => []);
const listCategories = vi.fn(async (): Promise<Record<string, unknown>[]> => []);
// Bound through the inbound port, over a fake ledger. These tests assert on real
// aggregated output, so they keep driving the whole application — see the routing
// tests at the end for the ones that no longer need a ledger at all.
const deps: ApiDeps = { reporting: reporting({ ledger: { listRange, listAccounts, listRuleSets, listCategories } }) };

const event = (over: Record<string, unknown> = {}) => ({
  rawPath: "/summary",
  requestContext: { authorizer: { jwt: { claims: { "custom:tenant": "frost" } } } },
  ...over,
});

const body = (res: { body: string }) => JSON.parse(res.body) as Record<string, unknown>;

beforeEach(() => {
  listRange.mockReset().mockResolvedValue({ transactions: [], enrichments: [], categorisations: [] });
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

  it("answers /transactions with the categorisation merged onto each row", async () => {
    // The category comes from a separate categorisation row keyed to the
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
      enrichments: [],
      categorisations: [
        {
          dedupKey: "k1",
          timestamp: "2026-03-15T00:00:00Z",
          category: "Groceries",
          setId: "built-in",
          setVersion: 2,
          version: 1,
          status: "effective",
          appliedAt: "2026-03-16T00:00:00Z",
        },
      ],
    });
    listRuleSets.mockResolvedValue([{ setId: "built-in", order: 2 }]);
    const res = await route(deps, event({ rawPath: "/v1/transactions" }) as never);
    const rows = body(res)["transactions"] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!["category"]).toBe("Groceries");
    // And says which set decided, which is what replaced the `provisional` flag.
    expect(rows[0]!["setId"]).toBe("built-in");
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

  it("does not serve table keys, the tenant or the provider's account id", async () => {
    // /accounts used to return whatever DynamoDB held, so the partition key,
    // the household id and TrueLayer's own account id all went to the browser.
    // None is any use to a client and all three become a promise once served.
    listAccounts.mockResolvedValue([
      {
        pk: "T#frost",
        sk: "ACCOUNT#acc-1",
        gsi1pk: "T#frost#ACCOUNT#acc-1",
        kind: "ACCOUNT",
        tenantId: "frost",
        provider: "truelayer",
        providerAccountId: "provider-internal-id",
        accountId: "acc-1",
        displayName: "Current",
        institutionName: "First Direct",
        currency: "GBP",
        isCard: false,
        currentBalance: 123_45,
      },
    ]);
    const res = await route(deps, event({ rawPath: "/v1/accounts" }) as never);
    const [account] = body(res)["accounts"] as Array<Record<string, unknown>>;

    for (const leaked of ["pk", "sk", "gsi1pk", "kind", "tenantId", "provider", "providerAccountId"]) {
      expect(account).not.toHaveProperty(leaked);
    }
    expect(account).toEqual({
      accountId: "acc-1",
      displayName: "Current",
      institutionName: "First Direct",
      currency: "GBP",
      isCard: false,
      currentBalance: 123_45,
    });
  });

  it("passes on a half-written account rather than dropping it", async () => {
    // putBalances creates the row when balances arrive before details. Omitting
    // such an account understates the household's position, which is a quieter
    // wrong answer than showing it incomplete. isCard stays absent — "not yet
    // known" is not "not a card". See #29.
    listAccounts.mockResolvedValue([
      { pk: "T#frost", sk: "ACCOUNT#acc-2", tenantId: "frost", accountId: "acc-2", currentBalance: 500_00 },
    ]);
    const res = await route(deps, event({ rawPath: "/v1/accounts" }) as never);
    const [account] = body(res)["accounts"] as Array<Record<string, unknown>>;
    expect(account).toEqual({ accountId: "acc-2", currentBalance: 500_00 });
    expect(account).not.toHaveProperty("isCard");
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
  it("binds the use cases to a real store rather than returning a placeholder", () => {
    // Only the entry point may run a constructor, so nothing else covers it.
    // It now yields the inbound port, not the store: the routing depends on what
    // the application offers, and the store is an implementation detail resolved
    // here and nowhere else.
    const app = realDeps().reporting;
    expect(app).toEqual(
      expect.objectContaining({
        summary: expect.any(Function),
        transactions: expect.any(Function),
        accounts: expect.any(Function),
        balances: expect.any(Function),
      }),
    );
  });
});

describe("the Lambda entry point", () => {
  it("wires the real dependencies through to the routing", async () => {
    // Exercises the entry point, which nothing else reaches: it builds a real
    // DynamoStore and delegates. The 403 path returns before any call is made, so
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

describe("balance over time", () => {
  const accountRows = [
    { accountId: "cur", isCard: false, currentBalance: 900_00, lastSyncedAt: "2026-03-05T05:00:00Z" },
    { accountId: "card", isCard: true, currentBalance: 100_00, lastSyncedAt: "2026-03-05T05:00:00Z" },
  ];
  // Both opened inside the data — running balance equals the first amount, and
  // the card's transactions sum to what it owes — so nothing constrains the
  // range and the clamp does not interfere with these assertions.
  const txnRows = [
    {
      accountId: "cur",
      dedupKey: "c1",
      timestamp: "2026-03-01T00:00:00Z",
      amount: 500_00,
      runningBalance: 500_00,
      currency: "GBP",
      description: "",
      transactionType: "CREDIT",
    },
    {
      accountId: "card",
      dedupKey: "k1",
      timestamp: "2026-03-02T00:00:00Z",
      amount: -100_00,
      currency: "GBP",
      description: "",
      transactionType: "DEBIT",
    },
  ];

  beforeEach(() => {
    listAccounts.mockResolvedValue(accountRows);
    listRange.mockResolvedValue({ transactions: txnRows, enrichments: [], categorisations: [] });
  });

  it("returns a point for every day in the range", async () => {
    const res = await route(deps, event({ rawPath: "/v1/balances", queryStringParameters: { from: "2026-03-01", to: "2026-03-05" } }));
    const body = JSON.parse(res.body);
    expect(body.points.map((p: { date: string }) => p.date)).toEqual([
      "2026-03-01",
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
    ]);
  });

  it("reads the whole history, not just the requested range", async () => {
    // A card's balance on a given day is what is owed now less everything
    // since, so transactions *after* the requested range are load-bearing.
    // Reading only the range made every card's history wrong by whatever
    // happened afterwards — and `rangeFrom` defaults to a rolling year, so an
    // unqualified /accounts reported every account as starting a year ago.
    await route(deps, event({ rawPath: "/v1/balances", queryStringParameters: { from: "2026-03-01", to: "2026-03-02" } }));
    const ranges = listRange.mock.calls.map((c) => c[1]);
    expect(ranges.some((r) => r.from === "1970-01-01")).toBe(true);
  });

  it("subtracts card debt, so the last point matches the account tiles", async () => {
    // £900 cash less £100 owed. The same figure the net-position tile shows,
    // because a chart disagreeing with the headline number reads as a bug.
    const res = await route(deps, event({ rawPath: "/v1/balances", queryStringParameters: { from: "2026-03-01", to: "2026-03-05" } }));
    const body = JSON.parse(res.body);
    expect(body.points[body.points.length - 1].net).toBe(800_00);
  });

  it("clamps the range and says where it actually starts", async () => {
    // An account that plainly existed before our data constrains the total.
    listRange.mockResolvedValue({
      transactions: [
        { ...txnRows[0], runningBalance: 900_00, timestamp: "2026-03-03T00:00:00Z" },
        txnRows[1],
      ],
      enrichments: [],
      categorisations: [],
    });
    const res = await route(deps, event({ rawPath: "/v1/balances", queryStringParameters: { from: "2026-01-01", to: "2026-03-05" } }));
    const body = JSON.parse(res.body);
    expect(body.range.from).toBe("2026-03-03");
    expect(body.points[0].date).toBe("2026-03-03");
  });
});

describe("what /accounts says about coverage", () => {
  it("reports where each account's history starts and whether anything precedes it", async () => {
    listAccounts.mockResolvedValue([
      { accountId: "cur", isCard: false, currentBalance: 100_00, lastSyncedAt: "2026-03-05T05:00:00Z" },
    ]);
    listRange.mockResolvedValue({
      transactions: [
        {
          accountId: "cur",
          dedupKey: "c1",
          timestamp: "2026-03-01T00:00:00Z",
          amount: -20_00,
          runningBalance: 480_00,
          currency: "GBP",
          description: "",
          transactionType: "DEBIT",
        },
      ],
      enrichments: [],
      categorisations: [],
    });
    const res = await route(deps, event({ rawPath: "/v1/accounts" }));
    const body = JSON.parse(res.body);
    expect(body.accounts[0].historyFrom).toBe("2026-03-01");
    // £500 before the first transaction we hold, so it existed earlier.
    expect(body.accounts[0].historyComplete).toBe(false);
    expect(body.completeFrom).toBe("2026-03-01");
  });

  it("omits completeFrom when no account constrains the range", async () => {
    listAccounts.mockResolvedValue([{ accountId: "cur", isCard: false }]);
    listRange.mockResolvedValue({ transactions: [], enrichments: [], categorisations: [] });
    const res = await route(deps, event({ rawPath: "/v1/accounts" }));
    const body = JSON.parse(res.body);
    expect(body.completeFrom).toBeUndefined();
    // Absent, not false: there is no earliest balance to test. Same rule as
    // isCard in #29.
    expect(body.accounts[0].historyComplete).toBeUndefined();
  });
});

describe("routing, against the application rather than through it", () => {
  /**
   * What the inbound port bought.
   *
   * Every test above fakes `LedgerReads` and lets the aggregation run, so a
   * routing assertion depends on transfer detection, coverage and currency
   * checking all behaving. These fake `Reporting` instead: the port's functions,
   * no rows, no aggregation. A break here is a routing break.
   */
  const called: string[] = [];
  const fake: Reporting = {
    summary: async () => {
      called.push("summary");
      return { currency: "GBP", from: "2026-01-01", to: "2026-01-31", transactionCount: 0, income: 0, spend: 0, net: 0, byCategory: [], byMonth: [], internalTransfersNetted: true, transferCount: 0, transferTotal: 0, enrichedCount: 0 };
    },
    transactions: async (_t, range) => {
      called.push("transactions");
      return { range, transactions: [] };
    },
    categories: async () => {
      called.push("categories");
      return { categories: [] };
    },
    accounts: async () => {
      called.push("accounts");
      return { accounts: [] };
    },
    balances: async (_t, range) => {
      called.push("balances");
      return { range, points: [] };
    },
  };
  const only: ApiDeps = { reporting: fake };

  beforeEach(() => {
    called.length = 0;
  });

  it.each([
    ["/summary", "summary"],
    ["/transactions", "transactions"],
    ["/accounts", "accounts"],
    ["/balances", "balances"],
  ])("dispatches %s to exactly one use case", async (path, expected) => {
    const res = await route(only, event({ rawPath: `/v1${path}` }));
    expect(res.statusCode).toBe(200);
    expect(called).toEqual([expected]);
  });

  it("passes the resolved household through, never anything from the request", async () => {
    // The tenant rule is the whole access-control model. Here it is checked
    // directly, rather than inferred from which rows came back.
    let seen: string | undefined;
    await route(
      { reporting: { ...fake, accounts: async (t) => { seen = t; return { accounts: [] }; } } },
      event({ rawPath: "/v1/accounts", queryStringParameters: { tenantId: "someone-else" } }),
    );
    expect(seen).toBe("frost");
  });

  it("still 404s a path no use case serves", async () => {
    const res = await route(only, event({ rawPath: "/v1/nope" }));
    expect(res.statusCode).toBe(404);
    expect(called).toEqual([]);
  });

  it("turns a use-case failure into a 500 that says nothing about the cause", async () => {
    // A thrown error can carry key material and table structure.
    const boom: ApiDeps = {
      reporting: { ...fake, summary: async () => { throw new Error("table tightarse-prod scan denied"); } },
    };
    const res = await route(boom, event({ rawPath: "/v1/summary" }));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("tightarse-prod");
  });
});

describe("events that are not shaped as expected", () => {
  it("treats a missing path as the root, and 404s it", () => {
    // API Gateway always sends rawPath, but a direct invocation or a payload
    // version change may not. Reading undefined as a route would match nothing
    // and throw inside the matcher rather than answering.
    return route(deps, { requestContext: { authorizer: { jwt: { claims: { "custom:tenant": "frost" } } } } } as never)
      .then((res) => expect(res.statusCode).toBe(404));
  });

  it("reports a non-Error failure without leaking its shape", async () => {
    // A thrown string or object has no .message. Interpolating it into the body
    // is how a stack trace or a table name reaches a client.
    const throwing = {
      reporting: {
        summary: async () => { throw "a bare string"; },
        transactions: async () => ({ range: { from: "", to: "" }, transactions: [] }),
        accounts: async () => ({ accounts: [] }),
        balances: async () => ({ range: { from: "", to: "" }, points: [] }),
      },
    };
    const res = await route(throwing as never, event({ rawPath: "/v1/summary" }));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: "Internal error" });
  });
});

describe("what the package exposes", () => {
  it("exports the Lambda entry point from the package entry", async () => {
    // package.json points `main` here. CDK bundles handler.ts by path rather
    // than through this barrel, so a broken export would not fail a deploy — it
    // would fail whoever imported the package next, which is worse.
    const pkg = await import("../src/index.js");
    expect(typeof pkg.handler).toBe("function");
    expect(typeof pkg.route).toBe("function");
  });
});

describe("the category catalogue", () => {
  it("serves what a picker needs", async () => {
    const spy: ApiDeps = {
      reporting: {
        summary: vi.fn(),
        accounts: vi.fn(),
        balances: vi.fn(),
        transactions: vi.fn(),
        categories: vi.fn(async () => ({
          categories: [{ id: "fuel", label: "Fuel", kind: "spending" }],
        })),
      } as unknown as Reporting,
    };

    const res = await route(spy, event({ rawPath: "/categories" }) as never);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ categories: [{ id: "fuel", label: "Fuel", kind: "spending" }] });
  });

  it("takes the household from the claim here too", async () => {
    const seen: string[] = [];
    const spy: ApiDeps = {
      reporting: {
        summary: vi.fn(),
        accounts: vi.fn(),
        balances: vi.fn(),
        transactions: vi.fn(),
        categories: vi.fn(async (t: string) => {
          seen.push(t);
          return { categories: [] };
        }),
      } as unknown as Reporting,
    };

    await route(spy, event({ rawPath: "/categories" }) as never);

    expect(seen).toEqual(["frost"]);
  });
});

describe("narrowing the list", () => {
  const spying = (seen: unknown[]): ApiDeps => ({
    reporting: {
      summary: vi.fn(),
      accounts: vi.fn(),
      balances: vi.fn(),
      categories: vi.fn(),
      transactions: vi.fn(async (_t: string, _r: unknown, filter?: unknown) => {
        seen.push(filter);
        return { range: { from: "2026-01-01", to: "2026-12-31" }, transactions: [] };
      }),
    } as unknown as Reporting,
  });

  const asked = async (params: Record<string, string>) => {
    const seen: unknown[] = [];
    const res = await route(
      spying(seen),
      event({ rawPath: "/transactions", queryStringParameters: params }) as never,
    );
    return { seen, res };
  };

  it("carries every condition through, and they combine", async () => {
    const { seen } = await asked({ q: "somemart", type: "DIRECT_DEBIT", min: "9000", max: "10000" });

    expect(seen).toEqual([{ term: "somemart", type: "DIRECT_DEBIT", min: 9000, max: 10000 }]);
  });

  it.each([
    ["only a term", { q: "somemart" }, { term: "somemart" }],
    ["only a type", { type: "DIRECT_DEBIT" }, { type: "DIRECT_DEBIT" }],
    ["only a floor", { min: "9000" }, { min: 9000 }],
    ["only a ceiling", { max: "10000" }, { max: 10000 }],
  ])("takes %s on its own", async (_case, params, expected) => {
    const { seen } = await asked(params);

    expect(seen).toEqual([expected]);
  });

  it.each([
    ["not a number", { min: "abc" }],
    ["negative", { min: "-500" }],
    ["fractional", { max: "10.5" }],
  ])("refuses a bound that is %s rather than ignoring it", async (_case, params) => {
    // Dropping it silently answers a question nobody asked, and looks like the
    // filter did nothing.
    const { res } = await asked(params);

    expect(res.statusCode).toBe(400);
  });

  it("refuses a range that runs backwards", async () => {
    const { res } = await asked({ min: "10000", max: "9000" });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("above");
  });

  it("passes the term through to the application", async () => {
    const seen: unknown[] = [];
    const spy: ApiDeps = {
      reporting: {
        summary: vi.fn(),
        accounts: vi.fn(),
        balances: vi.fn(),
        categories: vi.fn(),
        transactions: vi.fn(async (_t: string, _r: unknown, search?: string) => {
          seen.push(search);
          return { range: { from: "2026-01-01", to: "2026-12-31" }, transactions: [] };
        }),
      } as unknown as Reporting,
    };

    await route(spy, event({ rawPath: "/transactions", queryStringParameters: { q: "somemart" } }) as never);

    expect(seen).toEqual([{ term: "somemart" }]);
  });

  it.each([
    ["absent", {}],
    ["empty", { q: "" }],
  ])("asks for everything when the term is %s", async (_case, params) => {
    // A cleared search box sends `q=` on some clients, and answering that with
    // nothing would be a blank screen nobody asked for.
    const seen: unknown[] = [];
    const spy: ApiDeps = {
      reporting: {
        summary: vi.fn(),
        accounts: vi.fn(),
        balances: vi.fn(),
        categories: vi.fn(),
        transactions: vi.fn(async (_t: string, _r: unknown, search?: string) => {
          seen.push(search);
          return { range: { from: "2026-01-01", to: "2026-12-31" }, transactions: [] };
        }),
      } as unknown as Reporting,
    };

    await route(spy, event({ rawPath: "/transactions", queryStringParameters: params }) as never);

    expect(seen).toEqual([undefined]);
  });
});
