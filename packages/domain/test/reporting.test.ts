import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LedgerReads } from "@tightarse/domain";
import { accounts, balances, reporting, summary, toAccountFacts, toMovements, transactions } from "../src/reporting/reporting.js";

/**
 * The use cases, tested without an HTTP event.
 *
 * Everything here was previously reachable only by constructing a request —
 * which is why constraints like "coverage needs the whole history" sat inside an
 * HTTP handler where nobody adding a route would see them.
 */

const listRange = vi.fn();
const listAccounts = vi.fn();
const deps = { ledger: { listRange, listAccounts } satisfies LedgerReads };

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
  listRange.mockResolvedValue({ transactions: [], enrichments: [], categorisations: [] });
  listAccounts.mockResolvedValue([]);
});

describe("summary and transactions read only the range asked for", () => {
  it("passes the requested range straight through", async () => {
    await summary(deps, "frost", { from: "2026-01-01", to: "2026-02-01" });
    expect(listRange).toHaveBeenCalledWith("frost", { from: "2026-01-01", to: "2026-02-01" });
  });

  it("echoes the range with the transactions, so a caller knows what it got", async () => {
    const r = await transactions(deps, "frost", { from: "2026-01-01", to: "2026-02-01" });
    expect(r.range).toEqual({ from: "2026-01-01", to: "2026-02-01" });
  });
});

describe("coverage is computed from the whole history, never the request", () => {
  // The bug this prevents shipped once: `rangeFrom` defaults to a rolling year,
  // so answering coverage from the request reported every account as starting a
  // year ago and produced a completeFrom that moved with the calendar.
  beforeEach(() => {
    listAccounts.mockResolvedValue([{ accountId: "cur", isCard: false, currentBalance: 100_00 }]);
    listRange.mockResolvedValue({
      transactions: [txn({ timestamp: "2021-08-09T00:00:00Z", runningBalance: 480_00 })],
      enrichments: [],
      categorisations: [],
    });
  });

  it("asks for everything when answering /accounts", async () => {
    await accounts(deps, "frost");
    expect(listRange.mock.calls.some(([, r]) => r.from === "1970-01-01")).toBe(true);
  });

  it("asks for everything when answering /balances", async () => {
    await balances(deps, "frost", { from: "2026-01-01", to: "2026-03-01" });
    expect(listRange.mock.calls.some(([, r]) => r.from === "1970-01-01")).toBe(true);
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
    listAccounts.mockResolvedValue([{ accountId: "cur", isCard: false, currentBalance: 100_00 }]);
    listRange.mockResolvedValue({
      transactions: [txn({ timestamp: "2026-02-10T00:00:00Z", runningBalance: 480_00 })],
      enrichments: [],
      categorisations: [],
    });
    const r = await balances(deps, "frost", { from: "2021-01-01", to: "2026-03-01" });
    expect(r.range.from).toBe("2026-02-10");
    expect(r.points[0]!.date).toBe("2026-02-10");
  });

  it("gives one point per day across the served range", async () => {
    listAccounts.mockResolvedValue([{ accountId: "cur", isCard: false, currentBalance: 100_00 }]);
    listRange.mockResolvedValue({
      transactions: [txn({ timestamp: "2026-03-01T00:00:00Z", runningBalance: 100_00 })],
      enrichments: [],
      categorisations: [],
    });
    const r = await balances(deps, "frost", { from: "2026-03-01", to: "2026-03-05" });
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
        txn({ accountId: "old", dedupKey: "a", timestamp: "2021-08-09T00:00:00Z", runningBalance: 480_00 }),
        txn({ accountId: "new", dedupKey: "b", timestamp: "2025-02-10T00:00:00Z", runningBalance: 480_00 }),
      ],
      enrichments: [],
      categorisations: [],
    });
    const a = await accounts(deps, "frost");
    const b = await balances(deps, "frost", { from: "2000-01-01", to: "2026-03-01" });
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
  it("exposes exactly the port's four operations", () => {
    const app = reporting(deps);
    expect(Object.keys(app).sort()).toEqual(["accounts", "balances", "summary", "transactions"]);
  });

  it("routes every one of them to its use case", async () => {
    // Each binding is a separate arrow, so three working and one wired to the
    // wrong function would still expose the right four keys.
    listRange.mockResolvedValue({ transactions: [], enrichments: [] });
    listAccounts.mockResolvedValue([]);
    const app = reporting(deps);
    const range = { from: "2026-03-01", to: "2026-03-02" };

    await expect(app.summary("frost", range)).resolves.toHaveProperty("byCategory");
    await expect(app.transactions("frost", range)).resolves.toHaveProperty("transactions");
    await expect(app.accounts("frost")).resolves.toHaveProperty("accounts");
    await expect(app.balances("frost", range)).resolves.toHaveProperty("points");
  });

  it("passes the household through to the use case, not a default", () => {
    // The tenant comes from a verified claim and is the whole access-control
    // model; a binding that dropped it would read someone else's ledger.
    listAccounts.mockResolvedValue([]);
    listRange.mockResolvedValue({ transactions: [], enrichments: [] });
    return reporting(deps).accounts("frost").then(() => {
      expect(listAccounts).toHaveBeenCalledWith("frost");
    });
  });

  it("carries the summary options through rather than dropping them", async () => {
    // The reconciliation CLI shows netted against raw side by side. A binding
    // that ignored the option would show the same figure twice and look right.
    listRange.mockResolvedValue({
      transactions: [txn({ amount: -10_00 }), txn({ dedupKey: "d2", accountId: "b", amount: 10_00 })],
      enrichments: [],
    });
    const netted = await reporting(deps).summary("frost", { from: "2026-03-01", to: "2026-03-02" });
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
    listRange.mockResolvedValue({ transactions: [], enrichments: [] });
    listAccounts.mockResolvedValue([
      { accountId: "a", currentBalance: 100_00, lastSyncedAt: "2026-03-04T05:00:00.000Z" },
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
      { dedupKey: "c1", timestamp: "2026-03-01T00:00:00Z", amount: -10_00, accountId: "card" } as never,
    ]);
    expect(withOut).not.toHaveProperty("runningBalance");
  });

  it("keeps one a row does carry", () => {
    const [withIt] = toMovements([
      { dedupKey: "a1", timestamp: "2026-03-01T00:00:00Z", amount: -10_00, accountId: "cur", runningBalance: 90_00 } as never,
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
    expect(toAccountFacts({ accountId: "c", isCard: true, currentBalance: 200_00 })).toMatchObject({
      isCard: true,
      currentBalance: 200_00,
    });
  });
});
