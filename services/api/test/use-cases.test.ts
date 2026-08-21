import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LedgerReads } from "@tightarse/domain";
import { accounts, balances, summary, transactions } from "../src/use-cases";

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
