import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Adoptions } from "../src/categorisation/adoption.js";
import type { SharedRuleSets, LedgerReads } from "@tightarse/domain";
import {
  books,
  accounts,
  balances,
  categories,
  reporting,
  summary,
  toAccountFacts,
  toMovements,
  transactions,
  runningBalanceCheck,
} from "../src/reporting/reporting.js";

/**
 * The use cases, tested without an HTTP event.
 *
 * Everything here was previously reachable only by constructing a request —
 * which is why constraints like "coverage needs the whole history" sat inside an
 * HTTP handler where nobody adding a route would see them.
 */

const listRange = vi.fn();
const listAccounts = vi.fn();
// Typed, because an inferred `never[]` makes any set a type error the moment
// a test needs one — which is exactly what happened.
const listRuleSets = vi.fn(async (): Promise<Record<string, unknown>[]> => []);
const listCategorisationHistory = vi.fn(
  async (): Promise<Record<string, unknown>[]> => [],
);
const listConsents = vi.fn(async (): Promise<Record<string, unknown>[]> => []);
const getSettings = vi.fn(async (): Promise<null> => null);
const listCategories = vi.fn(
  async (): Promise<Record<string, unknown>[]> => [],
);
// Empty: every tenant today, so precedence still falls back to the sets' own
// order. See `precedenceFor`.
const getAdoptions = vi.fn(async (): Promise<Adoptions> => []);
const getRuleSetVersion = vi.fn(async () => undefined);
const NOW = "2026-08-30T00:00:00.000Z";

const deps = {
  ledger: {
    listRange,
    listAccounts,
    listRuleSets,
    getAdoptions,
    listCategories,
    listCategorisationHistory,
    listConsents,
    getSettings,
  } satisfies LedgerReads,
  // Separate: reading another tenant's set is its own capability.
  shared: { getRuleSetVersion } satisfies SharedRuleSets,
};

const txn = (over: Record<string, unknown> = {}) => ({
  dedupKey: "d1",
  timestamp: "2026-03-01T00:00:00Z",
  amount: -10_00,
  currency: "GBP",
  description: "",
  accountId: "cur",
  transactionType: "DEBIT",
  runningBalance: 100_00,
  ...over,
});

beforeEach(() => {
  listRange.mockReset();
  listAccounts.mockReset();
  listRange.mockResolvedValue({
    transactions: [],
    enrichments: [],
    categorisations: [],
  });
  listAccounts.mockResolvedValue([]);
});

describe("which sets a report uses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAdoptions.mockResolvedValue([]);
    getRuleSetVersion.mockResolvedValue(undefined);
    listRuleSets.mockResolvedValue([]);
  });

  it("reads the tenant's own sets when it has adopted nothing", async () => {
    // Every tenant today. The fallback exists so both forms coexist without a
    // data migration, and goes when every tenant has a list.
    await summary(deps, "frost", { from: "2026-01-01", to: "2026-12-31" });

    expect(listRuleSets).toHaveBeenCalledWith("frost");
    expect(getRuleSetVersion).not.toHaveBeenCalled();
  });

  it("fetches each adopted set from its owner, at the pinned version", async () => {
    // The pin made real. A shared set improving must not reach a household
    // until it adopts the newer version, so the read names a version rather
    // than taking whatever the owner has now.
    getAdoptions.mockResolvedValue([
      { owner: "tightarse", setId: "merchants", version: 7, adoptedAt: NOW },
      { owner: "frost", setId: "household", version: 2, adoptedAt: NOW },
    ]);

    await summary(deps, "frost", { from: "2026-01-01", to: "2026-12-31" });

    expect(getRuleSetVersion).toHaveBeenCalledWith("tightarse", "merchants", 7);
    expect(getRuleSetVersion).toHaveBeenCalledWith("frost", "household", 2);
    // The tenant's own current sets are not consulted at all once it has adopted.
    expect(listRuleSets).not.toHaveBeenCalled();
  });

  it("keeps reporting when an adopted set cannot be read", async () => {
    // A catalogue could retire a version. Losing one adopted set should lose
    // that set's rules, not the household's whole report.
    getAdoptions.mockResolvedValue([
      { owner: "tightarse", setId: "gone", version: 1, adoptedAt: NOW },
    ]);
    getRuleSetVersion.mockResolvedValue(undefined);

    await expect(
      summary(deps, "frost", { from: "2026-01-01", to: "2026-12-31" }),
    ).resolves.toBeDefined();
  });
});

describe("summary and transactions read only the range asked for", () => {
  it("passes the requested range straight through", async () => {
    await summary(deps, "frost", { from: "2026-01-01", to: "2026-02-01" });
    expect(listRange).toHaveBeenCalledWith("frost", {
      from: "2026-01-01",
      to: "2026-02-01",
    });
  });

  it("echoes the range with the transactions, so a caller knows what it got", async () => {
    const r = await transactions(deps, "frost", {
      from: "2026-01-01",
      to: "2026-02-01",
    });
    expect(r.range).toEqual({ from: "2026-01-01", to: "2026-02-01" });
  });
});

describe("coverage is computed from the whole history, never the request", () => {
  // The bug this prevents shipped once: `rangeFrom` defaults to a rolling year,
  // so answering coverage from the request reported every account as starting a
  // year ago and produced a completeFrom that moved with the calendar.
  beforeEach(() => {
    listAccounts.mockResolvedValue([
      { accountId: "cur", isCard: false, currentBalance: 100_00 },
    ]);
    listRange.mockResolvedValue({
      transactions: [
        txn({ timestamp: "2021-08-09T00:00:00Z", runningBalance: 480_00 }),
      ],
      enrichments: [],
      categorisations: [],
    });
  });

  it("asks for everything when answering /accounts", async () => {
    await accounts(deps, "frost");
    expect(listRange.mock.calls.some(([, r]) => r.from === "1970-01-01")).toBe(
      true,
    );
  });

  it("asks for everything when answering /balances", async () => {
    await balances(deps, "frost", { from: "2026-01-01", to: "2026-03-01" });
    expect(listRange.mock.calls.some(([, r]) => r.from === "1970-01-01")).toBe(
      true,
    );
  });

  it("reports where an account's history starts and whether anything precedes it", async () => {
    const r = await accounts(deps, "frost");
    expect(r.accounts[0]!.historyFrom).toBe("2021-08-09");
    // £490 before the first transaction we hold, so it existed earlier.
    expect(r.accounts[0]!.historyComplete).toBe(false);
    expect(r.completeFrom).toBe("2021-08-09");
  });
});

describe("balances clamps rather than drawing a total that omits an account", () => {
  it("returns the range it actually served", async () => {
    listAccounts.mockResolvedValue([
      { accountId: "cur", isCard: false, currentBalance: 100_00 },
    ]);
    listRange.mockResolvedValue({
      transactions: [
        txn({ timestamp: "2026-02-10T00:00:00Z", runningBalance: 480_00 }),
      ],
      enrichments: [],
      categorisations: [],
    });
    const r = await balances(deps, "frost", {
      from: "2021-01-01",
      to: "2026-03-01",
    });
    expect(r.range.from).toBe("2026-02-10");
    expect(r.points[0]!.date).toBe("2026-02-10");
  });

  it("gives one point per day across the served range", async () => {
    listAccounts.mockResolvedValue([
      { accountId: "cur", isCard: false, currentBalance: 100_00 },
    ]);
    listRange.mockResolvedValue({
      transactions: [
        txn({ timestamp: "2026-03-01T00:00:00Z", runningBalance: 100_00 }),
      ],
      enrichments: [],
      categorisations: [],
    });
    const r = await balances(deps, "frost", {
      from: "2026-03-01",
      to: "2026-03-05",
    });
    expect(r.points.map((p) => p.date)).toEqual([
      "2026-03-01",
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
    ]);
  });
});

describe("the two views agree about coverage", () => {
  it("clamps balances to the same date /accounts reports", async () => {
    // Computed in one place deliberately: a disagreement would show as a chart
    // starting on one date while the account list explains a different one.
    listAccounts.mockResolvedValue([
      { accountId: "old", isCard: false, currentBalance: 100_00 },
      { accountId: "new", isCard: false, currentBalance: 50_00 },
    ]);
    listRange.mockResolvedValue({
      transactions: [
        txn({
          accountId: "old",
          dedupKey: "a",
          timestamp: "2021-08-09T00:00:00Z",
          runningBalance: 480_00,
        }),
        txn({
          accountId: "new",
          dedupKey: "b",
          timestamp: "2025-02-10T00:00:00Z",
          runningBalance: 480_00,
        }),
      ],
      enrichments: [],
      categorisations: [],
    });
    const a = await accounts(deps, "frost");
    const b = await balances(deps, "frost", {
      from: "2000-01-01",
      to: "2026-03-01",
    });
    expect(b.range.from).toBe(a.completeFrom);
  });
});

describe("binding the use cases to the inbound port", () => {
  /**
   * `reporting()` is what a driver actually holds. Untested until now, which
   * meant the four functions were covered and the object that exposes them was
   * not — a wrong wiring here would give a driver the wrong answer from a
   * correct use case.
   */
  it("exposes exactly the port's operations", () => {
    const app = reporting(deps);
    expect(Object.keys(app).sort()).toEqual([
      "accounts",
      "balances",
      "books",
      "categories",
      "runningBalanceCheck",
      "summary",
      "transactions",
    ]);
  });

  it("routes every one of them to its use case", async () => {
    // Each binding is a separate arrow, so all but one working and that one
    // wired to the wrong function would still expose the right keys.
    listRange.mockResolvedValue({
      transactions: [],
      enrichments: [],
      categorisations: [],
    });
    listAccounts.mockResolvedValue([]);
    const app = reporting(deps);
    const range = { from: "2026-03-01", to: "2026-03-02" };

    await expect(app.summary("frost", range)).resolves.toHaveProperty(
      "byCategory",
    );
    await expect(app.transactions("frost", range)).resolves.toHaveProperty(
      "transactions",
    );
    await expect(app.accounts("frost")).resolves.toHaveProperty("accounts");
    await expect(app.balances("frost", range)).resolves.toHaveProperty(
      "points",
    );
    await expect(app.categories("frost")).resolves.toHaveProperty("categories");
    await expect(app.books("frost")).resolves.toHaveProperty(
      "householdPosition",
    );
    await expect(app.runningBalanceCheck("frost")).resolves.toHaveProperty(
      "verdict",
    );
  });

  it("passes the household through to the use case, not a default", () => {
    // The tenant comes from a verified claim and is the whole access-control
    // model; a binding that dropped it would read someone else's ledger.
    listAccounts.mockResolvedValue([]);
    listRange.mockResolvedValue({
      transactions: [],
      enrichments: [],
      categorisations: [],
    });
    return reporting(deps)
      .accounts("frost")
      .then(() => {
        expect(listAccounts).toHaveBeenCalledWith("frost");
      });
  });

  it("carries the summary options through rather than dropping them", async () => {
    // The reconciliation CLI shows netted against raw side by side. A binding
    // that ignored the option would show the same figure twice and look right.
    listRange.mockResolvedValue({
      transactions: [
        txn({ amount: -10_00 }),
        txn({ dedupKey: "d2", accountId: "b", amount: 10_00 }),
      ],
      enrichments: [],
      categorisations: [],
    });
    const netted = await reporting(deps).summary("frost", {
      from: "2026-03-01",
      to: "2026-03-02",
    });
    const raw = await reporting(deps).summary(
      "frost",
      { from: "2026-03-01", to: "2026-03-02" },
      { nettingTransfers: false },
    );
    expect(netted.internalTransfersNetted).toBe(true);
    expect(raw.internalTransfersNetted).toBe(false);
  });

  it("reports the balance as of the account's last sync, and omits it when never synced", async () => {
    // A current account's running balance is only as fresh as its last settled
    // transaction, so the live balance is dated rather than assumed to be today.
    // Absent lastSyncedAt must not become an invalid date.
    listRange.mockResolvedValue({
      transactions: [],
      enrichments: [],
      categorisations: [],
    });
    listAccounts.mockResolvedValue([
      {
        accountId: "a",
        currentBalance: 100_00,
        lastSyncedAt: "2026-03-04T05:00:00.000Z",
      },
      { accountId: "b", currentBalance: 50_00 },
    ]);
    const out = await reporting(deps).accounts("frost");
    expect(out.accounts).toHaveLength(2);
  });
});

describe("turning ledger rows into movements", () => {
  it("omits a running balance a row does not carry", () => {
    // Cards carry none at all — 0 of 2,287 across the household. Defaulting to
    // zero would make every card look like it had been paid off.
    const [withOut] = toMovements([
      {
        dedupKey: "c1",
        timestamp: "2026-03-01T00:00:00Z",
        amount: -10_00,
        accountId: "card",
      } as never,
    ]);
    expect(withOut).not.toHaveProperty("runningBalance");
  });

  it("keeps one a row does carry", () => {
    const [withIt] = toMovements([
      {
        dedupKey: "a1",
        timestamp: "2026-03-01T00:00:00Z",
        amount: -10_00,
        accountId: "cur",
        runningBalance: 90_00,
      } as never,
    ]);
    expect(withIt).toMatchObject({ runningBalance: 90_00 });
  });
});

describe("what is known about an account", () => {
  it("omits card-ness and balance a row does not state, rather than guessing", () => {
    // Absent isCard means NOT YET KNOWN, never "no". Treating absent as false
    // puts a card's balance into the cash total and subtracts nothing,
    // overstating the household by twice the debt — the shape of the £567.90 bug.
    // Absent currentBalance is likewise not zero: a balance never fetched is not
    // an account holding nothing.
    const facts = toAccountFacts({ accountId: "mid-sync" });
    expect(facts).toEqual({ accountId: "mid-sync" });
  });

  it("gives an id-less row an empty id rather than the string undefined", () => {
    // Balances arrive on their own endpoint and can create a row before account
    // details land. "undefined" as an account id would key a real series.
    expect(toAccountFacts({}).accountId).toBe("");
  });

  it("keeps both when the row does state them", () => {
    expect(
      toAccountFacts({ accountId: "c", isCard: true, currentBalance: 200_00 }),
    ).toMatchObject({
      isCard: true,
      currentBalance: 200_00,
    });
  });
});

describe("the category catalogue", () => {
  const cat = (
    id: string,
    label: string,
    over: Record<string, unknown> = {},
  ) => ({
    id,
    label,
    nature: "expense",
    retired: false,
    ...over,
  });

  const withCategories = (rows: Array<Record<string, unknown>>) => ({
    ledger: {
      listRange: async () => ({ transactions: [], categorisations: [] }),
      listAccounts: async () => [],
      listRuleSets: async () => [],
      getAdoptions: async () => [],
      getRuleSetVersion: async () => undefined,
      listCategories: async () => rows,
    },
  });

  it("offers what exists, not what has totals", async () => {
    const r = await categories(
      withCategories([cat("fuel", "Fuel")]) as never,
      "frost",
    );

    expect(r.categories).toEqual([
      { id: "fuel", label: "Fuel", nature: "expense" },
    ]);
  });

  it("leaves out retired ones rather than flagging them", async () => {
    // Filing something new under a retired category is what retiring it was
    // meant to stop, and refusing afterwards is a worse conversation than not
    // offering it.
    const r = await categories(
      withCategories([
        cat("fuel", "Fuel"),
        cat("petrol", "Petrol", { retired: true }),
      ]) as never,
      "frost",
    );

    expect(r.categories.map((c) => c.id)).toEqual(["fuel"]);
  });

  it("orders by label, the way a list is read", async () => {
    const r = await categories(
      withCategories([
        cat("z", "Zoo"),
        cat("a", "Aardvark"),
        cat("m", "Middle"),
      ]) as never,
      "frost",
    );

    expect(r.categories.map((c) => c.label)).toEqual([
      "Aardvark",
      "Middle",
      "Zoo",
    ]);
  });

  it("has nothing to offer a tenant with no catalogue", async () => {
    expect(
      (await categories(withCategories([]) as never, "frost")).categories,
    ).toEqual([]);
  });
});

describe("searching transactions", () => {
  const row = (description: string, amount = -10_00) => ({
    dedupKey: `d-${description}`,
    timestamp: "2026-01-05T00:00:00.000Z",
    amount,
    currency: "GBP",
    description,
    accountId: "a1",
    transactionType: "DEBIT",
  });

  const ledger = (rows: ReturnType<typeof row>[]) => ({
    listRange: async () => ({
      transactions: rows,
      categorisations: [] as Record<string, unknown>[],
    }),
    listAccounts: async () => [] as Record<string, unknown>[],
    listRuleSets: async (): Promise<Record<string, unknown>[]> => [],
    getAdoptions: async (): Promise<Adoptions> => [],
    listCategories: async (): Promise<Record<string, unknown>[]> => [],
  });

  const RANGE = { from: "2026-01-01", to: "2026-12-31" };
  const rows = [
    row("SOMEMART 118"),
    row("SOMEMART FORECOURT"),
    row("OTHERSHOP"),
  ];

  it("returns everything when nothing was asked for", async () => {
    const r = await transactions(
      { ledger: ledger(rows) } as never,
      "frost",
      RANGE,
    );

    expect(r.transactions).toHaveLength(3);
  });

  it("narrows to descriptions containing the term", async () => {
    const r = await transactions(
      { ledger: ledger(rows) } as never,
      "frost",
      RANGE,
      { term: "somemart" },
    );

    expect(r.transactions.map((t) => t.description).sort()).toEqual([
      "SOMEMART 118",
      "SOMEMART FORECOURT",
    ]);
  });

  it("ignores case, because descriptions arrive in whatever case the provider felt like", async () => {
    const r = await transactions(
      { ledger: ledger(rows) } as never,
      "frost",
      RANGE,
      { term: "SoMeMaRt" },
    );

    expect(r.transactions).toHaveLength(2);
  });

  it("takes the term literally, so a merchant with punctuation is not a pattern", async () => {
    // Unescaped, `PIZZA (EXPRESS)` is a group and matches "PIZZA EXPRESS"; a
    // lone `+` or `[` is a syntax error that would throw on every row.
    const punctuated = [row("PIZZA (EXPRESS) 42"), row("PIZZA EXPRESS 42")];
    const r = await transactions(
      { ledger: ledger(punctuated) } as never,
      "frost",
      RANGE,
      { term: "PIZZA (EXPRESS)" },
    );

    expect(r.transactions.map((t) => t.description)).toEqual([
      "PIZZA (EXPRESS) 42",
    ]);
  });

  it("does not throw on a term that would be a broken expression", async () => {
    await expect(
      transactions({ ledger: ledger(rows) } as never, "frost", RANGE, {
        term: "a+[",
      }),
    ).resolves.toBeDefined();
  });

  it("treats an empty term as no term, because a cleared box is not a filter", async () => {
    const r = await transactions(
      { ledger: ledger(rows) } as never,
      "frost",
      RANGE,
      { term: "" },
    );

    expect(r.transactions).toHaveLength(3);
  });

  it("searches credits too, because direction is the rule's business and not the search's", async () => {
    const mixed = [row("REFUND SOMEMART", 25_00), row("SOMEMART 118")];
    const r = await transactions(
      { ledger: ledger(mixed) } as never,
      "frost",
      RANGE,
      { term: "somemart" },
    );

    expect(r.transactions).toHaveLength(2);
  });

  it("finds nothing rather than everything when the term matches nothing", async () => {
    const r = await transactions(
      { ledger: ledger(rows) } as never,
      "frost",
      RANGE,
      { term: "NOTHING HERE" },
    );

    expect(r.transactions).toEqual([]);
  });
});

describe("what running_balance means, judged from the ledger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAdoptions.mockResolvedValue([]);
    listRuleSets.mockResolvedValue([]);
    listCategories.mockResolvedValue([]);
  });

  /** A chained account: each running balance is the position after its row. */
  const chained = (accountId: string, amounts: readonly number[]) => {
    let balance = 100_00;
    return amounts.map((amount, i) => {
      balance += amount;
      return txn({
        accountId,
        dedupKey: `${accountId}-${i}`,
        timestamp: `2026-03-0${i + 1}T00:00:00Z`,
        amount,
        runningBalance: balance,
      });
    });
  };

  it("answers closing when the household's own chain says so", async () => {
    listAccounts.mockResolvedValue([{ accountId: "cur", isCard: false }]);
    listRange.mockResolvedValue({
      transactions: chained("cur", [-10_00, -25_50, 40_00]),
      categorisations: [],
    });

    const report = await runningBalanceCheck(deps, "t1");

    expect(report.verdict).toBe("closing");
    expect(report.accounts[0]).toMatchObject({
      accountId: "cur",
      verdict: "closing",
      disagreeing: [],
    });
  });

  it("ignores a card rather than letting it outvote the accounts that can answer", async () => {
    // Every card is `insufficient`, and there are more cards than accounts in
    // some households. Counting them would turn a clear answer into no answer.
    listAccounts.mockResolvedValue([
      { accountId: "cur", isCard: false },
      { accountId: "card", isCard: true },
    ]);
    listRange.mockResolvedValue({
      transactions: [
        ...chained("cur", [-10_00, -25_50, 40_00]),
        txn({ accountId: "card", dedupKey: "c1", runningBalance: undefined }),
      ],
      categorisations: [],
    });

    const report = await runningBalanceCheck(deps, "t1");

    expect(report.verdict).toBe("closing");
    expect(
      report.accounts.find((a) => a.accountId === "card")?.verdict,
    ).toBe("insufficient");
  });

  it("is insufficient when nothing in the ledger can answer at all", async () => {
    listAccounts.mockResolvedValue([{ accountId: "card", isCard: true }]);
    listRange.mockResolvedValue({
      transactions: [txn({ accountId: "card", runningBalance: undefined })],
      categorisations: [],
    });

    expect((await runningBalanceCheck(deps, "t1")).verdict).toBe("insufficient");
  });

  it("lets one broken account decide, because a break is not a minority view", async () => {
    const broken = chained("brk", [-10_00, -25_50, 40_00]);
    broken[1] = { ...broken[1]!, runningBalance: 1 };
    listAccounts.mockResolvedValue([
      { accountId: "cur", isCard: false },
      { accountId: "brk", isCard: false },
    ]);
    listRange.mockResolvedValue({
      transactions: [...chained("cur", [-10_00, -25_50, 40_00]), ...broken],
      categorisations: [],
    });

    const report = await runningBalanceCheck(deps, "t1");

    expect(report.verdict).toBe("inconsistent");
    expect(
      report.accounts.find((a) => a.accountId === "brk")?.disagreeing.length,
    ).toBeGreaterThan(0);
  });

  it("copes with an account that has no transactions at all", async () => {
    // A newly connected account, or one whose history has not arrived. It has
    // nothing to say rather than being an error.
    listAccounts.mockResolvedValue([
      { accountId: "cur", isCard: false },
      { accountId: "empty", isCard: false },
    ]);
    listRange.mockResolvedValue({
      transactions: chained("cur", [-10_00, -25_50, 40_00]),
      categorisations: [],
    });

    const report = await runningBalanceCheck(deps, "t1");

    expect(
      report.accounts.find((a) => a.accountId === "empty"),
    ).toMatchObject({ verdict: "insufficient", pairs: 0, daysChecked: 0 });
    expect(report.verdict).toBe("closing");
  });

  it("is inconsistent when two accounts answer differently", async () => {
    // Not a tie to be broken: one provider field cannot mean two things, so two
    // accounts disagreeing means something is wrong beyond the reading.
    const opening = (accountId: string, amounts: readonly number[]) => {
      let balance = 100_00;
      return amounts.map((amount, i) => {
        const before = balance;
        balance += amount;
        return txn({
          accountId,
          dedupKey: `${accountId}-${i}`,
          timestamp: `2026-03-0${i + 1}T00:00:00Z`,
          amount,
          runningBalance: before,
        });
      });
    };
    listAccounts.mockResolvedValue([
      { accountId: "cur", isCard: false },
      { accountId: "opp", isCard: false },
    ]);
    listRange.mockResolvedValue({
      transactions: [
        ...chained("cur", [-10_00, -25_50, 40_00]),
        ...opening("opp", [-10_00, -25_50, 40_00]),
      ],
      categorisations: [],
    });

    expect((await runningBalanceCheck(deps, "t1")).verdict).toBe("inconsistent");
  });

  it("lets an account that can discriminate settle it for one that cannot", async () => {
    // Equal amounts throughout satisfy both readings and say nothing.
    listAccounts.mockResolvedValue([
      { accountId: "cur", isCard: false },
      { accountId: "flat", isCard: false },
    ]);
    listRange.mockResolvedValue({
      transactions: [
        ...chained("cur", [-10_00, -25_50, 40_00]),
        ...chained("flat", [-10_00, -10_00, -10_00]),
      ],
      categorisations: [],
    });

    const report = await runningBalanceCheck(deps, "t1");

    expect(
      report.accounts.find((a) => a.accountId === "flat")?.verdict,
    ).toBe("ambiguous");
    expect(report.verdict).toBe("closing");
  });
});

/**
 * Every book, and the household's own position.
 *
 * #108 step 3. The property under test is that one computation serves an
 * account, a category and a loan — and that a loan repayment moves the
 * household's position by nothing, which is the case the old arithmetic could
 * not express.
 *
 * Every figure and label is invented.
 */
/**
 * Consent, on the way to a screen.
 *
 * The dashboard reads this with the accounts, so a warning arrives with the
 * page rather than after it. The verdict comes from dates; the provider's own
 * status is carried and decides nothing.
 *
 * Every name and date here is invented.
 */
/**
 * A balance on every transaction.
 *
 * #33: "select a transaction and see the balance at that moment". A daily
 * position cannot answer it — every row is stamped midnight and the real ledger
 * holds up to 47 in a day — so this is the running total in the ledger's own
 * order, and the endpoint reads the history before the range to compute it.
 *
 * Every figure is invented.
 */
describe("the balance at each transaction", () => {
  beforeEach(() => {
    listAccounts.mockResolvedValue([{ accountId: "cur", isCard: false }]);
    listRuleSets.mockResolvedValue([]);
    getAdoptions.mockResolvedValue([]);
    listCategories.mockResolvedValue([]);
    listConsents.mockResolvedValue([]);
    getSettings.mockResolvedValue(null);
    listRange.mockClear();
  });

  const rows = [
    txn({ dedupKey: "a", accountId: "cur", amount: 500_00, runningBalance: 500_00, timestamp: "2026-03-01T00:00:00Z" }),
    txn({ dedupKey: "b", accountId: "cur", amount: -20_00, timestamp: "2026-03-01T00:00:00Z" }),
    txn({ dedupKey: "c", accountId: "cur", amount: -30_00, timestamp: "2026-03-02T00:00:00Z" }),
  ];

  it("gives each row the position after it, not the position on its day", () => {
    // `a` and `b` share a day. A daily figure could only report one number for
    // both; the ledger's own order gives each its own.
    listRange.mockResolvedValue({ transactions: rows, categorisations: [] });
    return transactions(deps, "frost", { from: "2026-03-01", to: "2026-03-31" }).then((r) => {
      const by = new Map(r.transactions.map((t) => [t.dedupKey, t.balance]));
      expect(by.get("a")).toBe(500_00);
      expect(by.get("b")).toBe(480_00);
      expect(by.get("c")).toBe(450_00);
    });
  });

  it("reads the history up to the range's end, and no further", async () => {
    // A running total needs everything before it. Reading past the range would
    // make an older range cost the same as today's for nothing.
    listRange.mockResolvedValue({ transactions: rows, categorisations: [] });
    await transactions(deps, "frost", { from: "2026-03-01", to: "2026-03-31" });
    const ranges = listRange.mock.calls.map((c) => c[1]);
    expect(ranges).toContainEqual({ from: "1970-01-01", to: "2026-03-31" });
  });

  it("passes over an account with nothing in it", async () => {
    // A newly connected account has a row before it has a transaction. Looking
    // up its movements finds none, which is a state rather than a fault.
    listAccounts.mockResolvedValue([
      { accountId: "cur", isCard: false },
      { accountId: "fresh", isCard: false },
    ]);
    listRange.mockResolvedValue({ transactions: rows, categorisations: [] });
    const r = await transactions(deps, "frost", { from: "2026-03-01", to: "2026-03-31" });
    expect(r.transactions).toHaveLength(3);
  });

  it("says nothing rather than something wrong when an account cannot be anchored", async () => {
    // No running balance anywhere, so there is no figure to start from. A
    // balance invented from the rows in hand is a total that began in the middle.
    listRange.mockResolvedValue({
      transactions: [
        { ...txn({ dedupKey: "a", accountId: "cur", amount: -20_00 }), runningBalance: undefined },
      ],
      categorisations: [],
    });
    const r = await transactions(deps, "frost", { from: "2026-03-01", to: "2026-03-31" });
    expect(r.transactions[0]).not.toHaveProperty("balance");
  });
});

describe("consents alongside the accounts", () => {
  const consentRow = (over: Record<string, unknown> = {}) => ({
    tenantId: "frost",
    consentId: "cred-1",
    provider: "truelayer",
    institutionName: "Some Bank",
    grantedAt: "2026-08-11T09:00:00Z",
    expiresAt: "2099-01-01T00:00:00Z",
    providerStatus: "Authorised",
    fetchedAt: new Date().toISOString(),
    ...over,
  });

  beforeEach(() => {
    listRange.mockResolvedValue({ transactions: [], categorisations: [] });
    listAccounts.mockResolvedValue([]);
    listCategories.mockResolvedValue([]);
    getSettings.mockResolvedValue(null);
  });

  it("judges each one and names the bank", async () => {
    listConsents.mockResolvedValue([consentRow()]);
    const r = await accounts(deps, "frost");
    expect(r.consents).toEqual([
      expect.objectContaining({
        consentId: "cred-1",
        institutionName: "Some Bank",
        providerStatus: "Authorised",
        health: "ok",
      }),
    ]);
  });

  it("puts the one that needs doing something about first", async () => {
    listConsents.mockResolvedValue([
      consentRow({ consentId: "far", expiresAt: "2099-01-01T00:00:00Z" }),
      consentRow({ consentId: "near", expiresAt: "2026-09-20T00:00:00Z" }),
    ]);
    const r = await accounts(deps, "frost");
    expect(r.consents.map((c) => c.consentId)).toEqual(["near", "far"]);
  });

  it("takes the thresholds from settings where a household has said", async () => {
    // A hundred days out: quiet under the default thirty, and a warning once
    // the household says it wants four months' notice.
    const inDays = (n: number) =>
      new Date(Date.now() + n * 864e5).toISOString();
    listConsents.mockResolvedValue([consentRow({ expiresAt: inDays(100) })]);

    getSettings.mockResolvedValue(null);
    expect((await accounts(deps, "frost")).consents[0]!.health).toBe("ok");

    getSettings.mockResolvedValue({
      consentWarnDays: 120,
      consentEscalateDays: 10,
    } as never);
    expect((await accounts(deps, "frost")).consents[0]!.health).toBe("warn");
  });

  it("falls back to thirty and ten when nothing has been said", async () => {
    // Nothing can write settings yet — see #151. The read path is already
    // correct, so the day a screen exists nothing here has to move.
    getSettings.mockResolvedValue(null);
    listConsents.mockResolvedValue([consentRow()]);
    expect((await accounts(deps, "frost")).consents[0]!.health).toBe("ok");
  });

  it("says nothing rather than something wrong about a row it cannot read", async () => {
    listConsents.mockResolvedValue([{ nonsense: true }, consentRow()]);
    const r = await accounts(deps, "frost");
    expect(r.consents).toHaveLength(1);
  });

  it("leaves out a bank name the provider did not give, rather than sending null", async () => {
    listConsents.mockResolvedValue([consentRow({ institutionName: undefined })]);
    const r = await accounts(deps, "frost");
    expect(r.consents[0]).not.toHaveProperty("institutionName");
  });

  it("has nothing to report before a sync has written one", async () => {
    listConsents.mockResolvedValue([]);
    expect((await accounts(deps, "frost")).consents).toEqual([]);
  });
});

describe("books", () => {
  const ledgerWith = (over: Record<string, unknown>) => ({
    ledger: {
      listRange: async () => ({ transactions: [], categorisations: [] }),
      listAccounts: async () => [],
      listRuleSets: async () => [],
      getAdoptions: async () => [],
      getRuleSetVersion: async () => undefined,
      listCategories: async () => [],
      ...over,
    },
  });

  const cat = (
    id: string,
    nature: string,
    openingPosition?: number,
  ): Record<string, unknown> => ({
    id,
    label: id,
    nature,
    taxonomy: "household",
    retired: false,
    ...(openingPosition === undefined ? {} : { openingPosition }),
  });

  it("gives an account and a category a position from the same arithmetic", async () => {
    const r = await books(
      ledgerWith({
        listAccounts: async () => [{ accountId: "cur", isCard: false }],
        listCategories: async () => [cat("groceries", "expense")],
        listRange: async () => ({
          transactions: [
            txn({
              dedupKey: "d1",
              accountId: "cur",
              amount: -30_00,
              runningBalance: 970_00,
            }),
          ],
          categorisations: [
            { dedupKey: "d1", category: "groceries", setId: "household", appliedAt: "2026-03-01T00:00:00Z" },
          ],
        }),
      }) as never,
      "frost",
    );

    const by = new Map(r.books.map((b) => [b.book, b]));
    // The account fell by 30; the groceries book rose by 30. One movement, two
    // ends, and the opening is recovered from the running balance.
    expect(by.get("cur")!.position).toBe(970_00);
    expect(by.get("groceries")!.position).toBe(30_00);
  });

  it("counts an account but not what was spent, so the total is what is held", async () => {
    const r = await books(
      ledgerWith({
        listAccounts: async () => [{ accountId: "cur", isCard: false }],
        listCategories: async () => [cat("groceries", "expense")],
        listRange: async () => ({
          transactions: [
            txn({ dedupKey: "d1", accountId: "cur", amount: -30_00, runningBalance: 970_00 }),
          ],
          categorisations: [
            { dedupKey: "d1", category: "groceries", setId: "household", appliedAt: "2026-03-01T00:00:00Z" },
          ],
        }),
      }) as never,
      "frost",
    );
    expect(r.householdPosition).toBe(970_00);
    expect(by(r, "groceries").rollsUp).toBe(false);
  });

  it("opens a loan at what is owed, so its position is debt and not repayments", async () => {
    // Without the opening this book reads +£500: how much has been paid off.
    // With it, it reads what is still owed, which is the figure anybody wants.
    const r = await books(
      ledgerWith({
        listAccounts: async () => [{ accountId: "cur", isCard: false }],
        listCategories: async () => [cat("mortgage", "liability", -180_000_00)],
        listRange: async () => ({
          transactions: [
            txn({ dedupKey: "d1", accountId: "cur", amount: -500_00, runningBalance: 2_500_00 }),
          ],
          categorisations: [
            { dedupKey: "d1", category: "mortgage", setId: "household", appliedAt: "2026-03-01T00:00:00Z" },
          ],
        }),
      }) as never,
      "frost",
    );
    expect(by(r, "mortgage").position).toBe(-179_500_00);
    expect(by(r, "mortgage").rollsUp).toBe(true);
    // 2_500_00 held, 179_500_00 owed.
    expect(r.householdPosition).toBe(2_500_00 - 179_500_00);
  });

  it("treats a card as a liability, because what it holds is owed", async () => {
    const r = await books(
      ledgerWith({
        listAccounts: async () => [
          { accountId: "card", isCard: true, currentBalance: 421_50 },
        ],
        listRange: async () => ({
          transactions: [txn({ dedupKey: "d1", accountId: "card", amount: -21_50 })],
          categorisations: [],
        }),
      }) as never,
      "frost",
    );
    expect(by(r, "card").nature).toBe("liability");
    // Negative in leg convention: the household is down by what it owes.
    expect(by(r, "card").position).toBe(-421_50);
    expect(r.householdPosition).toBe(-421_50);
  });

  it("opens an account with nothing in it at nothing, rather than throwing", async () => {
    // A newly connected account has a row before it has a transaction, and no
    // running balance to recover an opening from. Zero is the honest answer
    // and the panel is what says the history is still arriving.
    const r = await books(
      ledgerWith({
        listAccounts: async () => [{ accountId: "fresh", isCard: false }],
      }) as never,
      "frost",
    );
    expect(by(r, "fresh").position).toBe(0);
    expect(r.householdPosition).toBe(0);
  });

  it("keeps a book out of what the household is worth when it is told to", async () => {
    // Transfer is the case. Its nature is asset — it is not spending — but
    // where the money went is the one thing a transfer does not say, so
    // counting it as held double-counts anything that landed in an account we
    // already read.
    const r = await books(
      ledgerWith({
        listAccounts: async () => [{ accountId: "cur", isCard: false }],
        listCategories: async () => [
          { ...cat("transfer", "asset"), rollsUp: false },
        ],
        listRange: async () => ({
          transactions: [
            txn({ dedupKey: "d1", accountId: "cur", amount: -500_00, runningBalance: 500_00 }),
          ],
          categorisations: [
            { dedupKey: "d1", category: "transfer", setId: "household", appliedAt: "2026-03-01T00:00:00Z" },
          ],
        }),
      }) as never,
      "frost",
    );
    expect(by(r, "transfer").position).toBe(500_00);
    expect(by(r, "transfer").rollsUp).toBe(false);
    // The money left the account and is not claimed as held elsewhere.
    expect(r.householdPosition).toBe(500_00);
  });

  it("still takes the nature's word where nothing was said", async () => {
    const r = await books(
      ledgerWith({
        listCategories: async () => [cat("savings-elsewhere", "asset")],
      }) as never,
      "frost",
    );
    expect(by(r, "savings-elsewhere").rollsUp).toBe(true);
  });

  it("leaves a retired category out, because nothing can be filed there now", async () => {
    const r = await books(
      ledgerWith({
        listCategories: async () => [
          { ...cat("old", "expense"), retired: true },
          cat("current", "expense"),
        ],
      }) as never,
      "frost",
    );
    expect(r.books.map((b) => b.book)).toEqual(["current"]);
  });

  it("opens an untransacted book at nothing, which is right for every category", async () => {
    const r = await books(
      ledgerWith({ listCategories: async () => [cat("groceries", "expense")] }) as never,
      "frost",
    );
    expect(by(r, "groceries").position).toBe(0);
  });
});

function by(r: { books: readonly { book: string }[] }, id: string) {
  return r.books.find((b) => b.book === id) as never as {
    position: number;
    rollsUp: boolean;
    nature: string;
  };
}

/**
 * #108 step 4: what did March say in April?
 *
 * Every figure the dashboard shows is derived from rules, and rules change. So
 * a total is only ever "as we understand things now" — and until this, that was
 * the only reading available. The data could always answer the other question;
 * nothing asked it.
 *
 * Two properties matter and they pull against each other. The answer has to be
 * right, and asking about *now* has to cost nothing, because that is every
 * existing caller. History lives in its own partition precisely so the second
 * holds, and these tests pin both.
 *
 * Every figure and label is invented.
 */
describe("the summary as it stood", () => {
  const MARCH = "2026-03-01T00:00:00Z";
  const range = { from: "2026-03-01", to: "2026-03-31" };

  const cat = (over: Record<string, unknown>) => ({
    dedupKey: "d1",
    timestamp: MARCH,
    category: "groceries",
    setId: "household",
    setVersion: 1,
    version: 1,
    status: "effective",
    appliedAt: "2026-03-15T00:00:00Z",
    ...over,
  });

  beforeEach(() => {
    // Calls cleared as well as answers set. This file does not reset between
    // tests, so a call-count assertion otherwise counts the ones before it —
    // which is how "reads no history at all" passed while only being true
    // first in the file.
    listCategorisationHistory.mockClear();
    listAccounts.mockResolvedValue([]);
    listRuleSets.mockResolvedValue([]);
    getAdoptions.mockResolvedValue([]);
    listCategories.mockResolvedValue([]);
    listCategorisationHistory.mockResolvedValue([]);
  });

  const withRows = (categorisations: Record<string, unknown>[]) =>
    listRange.mockResolvedValue({
      transactions: [txn({ dedupKey: "d1", amount: -30_00, timestamp: MARCH })],
      categorisations,
      enrichments: [],
    });

  it("reads no history at all when the question is about now", () => {
    // The cost property. Every caller that has ever existed asks this, and it
    // must stay one read of the ledger rather than one per transaction.
    withRows([cat({})]);
    return summary(deps, "frost", range).then(() => {
      expect(listCategorisationHistory).not.toHaveBeenCalled();
    });
  });

  it("gives the same answer as no as-at when asked about now", async () => {
    withRows([cat({})]);
    const now = await summary(deps, "frost", range);
    const asNow = await summary(deps, "frost", range, {
      asAt: "2099-01-01T00:00:00Z",
    });
    expect(asNow.byCategory).toEqual(now.byCategory);
  });

  it("does not know a categorisation that had not been made yet", async () => {
    // Filed on the 15th. Asked about the 10th, the transaction was not yet
    // filed under anything of ours, so it falls back to the provider's book —
    // which is what the screen showed on the 10th.
    withRows([cat({})]);
    const then = await summary(deps, "frost", range, {
      asAt: "2026-03-10T00:00:00Z",
    });
    expect(then.byCategory.map((c) => c.category)).not.toContain("groceries");
  });

  it("reads the history only for a transaction that changed since", async () => {
    withRows([
      cat({ dedupKey: "d1", appliedAt: "2026-06-01T00:00:00Z", version: 2 }),
    ]);
    await summary(deps, "frost", range, { asAt: "2026-04-01T00:00:00Z" });
    expect(listCategorisationHistory).toHaveBeenCalledTimes(1);
    expect(listCategorisationHistory).toHaveBeenCalledWith("frost", "d1");
  });

  it("answers with what the earlier version said, not the current one", async () => {
    // Filed as groceries in March, moved to fuel in June. Asked about April,
    // March's answer is the one that stood.
    withRows([
      cat({ category: "fuel", version: 2, appliedAt: "2026-06-01T00:00:00Z" }),
    ]);
    listCategorisationHistory.mockResolvedValue([
      cat({ category: "groceries", version: 1, appliedAt: "2026-03-15T00:00:00Z" }),
      cat({ category: "fuel", version: 2, appliedAt: "2026-06-01T00:00:00Z" }),
    ]);
    const april = await summary(deps, "frost", range, {
      asAt: "2026-04-01T00:00:00Z",
    });
    expect(april.byCategory.map((c) => c.category)).toContain("groceries");
    expect(april.byCategory.map((c) => c.category)).not.toContain("fuel");
  });

  it("ignores a row it cannot read, rather than failing the whole answer", async () => {
    // The batch read returns whatever is in the partition. A row that is not a
    // categorisation cannot say when it was applied, so it cannot be evidence
    // that anything changed — skipped, exactly as `effectiveCategories` skips
    // it, rather than throwing an otherwise good answer away.
    withRows([{ dedupKey: "d1", nonsense: true }, cat({})]);
    const then = await summary(deps, "frost", range, {
      asAt: "2026-03-10T00:00:00Z",
    });
    expect(then.transactionCount).toBe(1);
  });

  it("moves nothing about when the money moved", async () => {
    // Only what we decided is in doubt. A transaction's own date is the bank's
    // fact and an as-at cannot touch it.
    withRows([cat({})]);
    const then = await summary(deps, "frost", range, {
      asAt: "2026-03-10T00:00:00Z",
    });
    expect(then.transactionCount).toBe(1);
    expect(then.spend).toBe(-30_00);
  });
});
