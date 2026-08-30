import { describe, it, expect } from "vitest";
import {
  clampToCoverage,
  completeFrom,
  coverageOf,
  openingBalance,
} from "../src/reporting/coverage.js";
import type { AccountFacts, Movement } from "../src/reporting/balances.js";

// Distinct and ascending, mirroring the ledger's tiebreak within a timestamp.
let cardKey = 0;

const current: AccountFacts = { accountId: "cur", isCard: false };
const card: AccountFacts = {
  accountId: "card",
  isCard: true,
  currentBalance: 50_00,
};

let seq = 0;
const m = (
  timestamp: string,
  amount: number,
  runningBalance?: number,
): Movement => ({
  accountId: "cur",
  timestamp,
  amount,
  dedupKey: `d${String(seq++).padStart(4, "0")}`,
  ...(runningBalance !== undefined ? { runningBalance } : {}),
});

describe("opening balance", () => {
  it("takes a current account's from the provider's own running total", () => {
    // Running balance is stated after the transaction, so the balance before it
    // is that figure less the transaction's own amount.
    const rows = [
      m("2025-01-10T00:00:00Z", -20_00, 80_00),
      m("2025-02-10T00:00:00Z", -5_00, 75_00),
    ];
    expect(openingBalance(current, rows)).toBe(100_00);
  });

  it("unwinds a card back to its start from what is owed today", () => {
    // Spent £30 and £20 in total, owes £50 now, so it started at nothing. The
    // same arithmetic reconciliation runs, which is what validates it against
    // real balance readings rather than against itself.
    const rows = [
      {
        accountId: "card",
        dedupKey: `c${cardKey++}`,
        timestamp: "2025-01-10T00:00:00Z",
        amount: -30_00,
      },
      {
        accountId: "card",
        dedupKey: `c${cardKey++}`,
        timestamp: "2025-02-10T00:00:00Z",
        amount: -20_00,
      },
    ];
    expect(openingBalance(card, rows)).toBe(0);
  });

  it("finds the debt a card was already carrying", () => {
    // Owes £50 having only ever spent £20, so £30 predates our data. This is
    // the real case: every card in the household reports one.
    const rows = [
      {
        accountId: "card",
        dedupKey: `c${cardKey++}`,
        timestamp: "2025-01-10T00:00:00Z",
        amount: -20_00,
      },
    ];
    expect(openingBalance(card, rows)).toBe(30_00);
  });

  it("says nothing rather than zero when it cannot tell", () => {
    // "Cannot tell" read as "opened here" would mark a truncated account
    // complete and let it stop constraining the range — the exact failure this
    // whole rule exists to prevent.
    expect(openingBalance(current, [])).toBeUndefined();
    expect(
      openingBalance(current, [m("2025-01-10T00:00:00Z", -20_00)]),
    ).toBeUndefined();
    expect(
      openingBalance({ accountId: "card", isCard: true }, [
        {
          accountId: "card",
          dedupKey: `c${cardKey++}`,
          timestamp: "2025-01-10T00:00:00Z",
          amount: -20_00,
        },
      ]),
    ).toBeUndefined();
  });
});

describe("coverage of one account", () => {
  it("marks an account opened inside the data as complete", () => {
    const rows = [m("2025-01-10T00:00:00Z", -20_00, -20_00)];
    expect(coverageOf(current, rows)).toEqual({
      accountId: "cur",
      historyFrom: "2025-01-10",
      historyComplete: true,
    });
  });

  it("marks an account that plainly existed earlier as incomplete", () => {
    const rows = [m("2025-01-10T00:00:00Z", -20_00, 480_00)];
    expect(coverageOf(current, rows)).toMatchObject({
      historyFrom: "2025-01-10",
      historyComplete: false,
    });
  });

  it("tolerates a few pence, because a card's opening balance is derived", () => {
    // Summed across thousands of transactions against today's balance, so one
    // missing refund leaves a residue. Exact zero would make the verdict turn
    // on rounding; a pound is far below any real opening balance.
    const rows = [
      {
        accountId: "card",
        dedupKey: `c${cardKey++}`,
        timestamp: "2025-01-10T00:00:00Z",
        amount: -49_99,
      },
    ];
    expect(coverageOf(card, rows).historyComplete).toBe(true);
    const bigger = [
      {
        accountId: "card",
        dedupKey: `c${cardKey++}`,
        timestamp: "2025-01-10T00:00:00Z",
        amount: -40_00,
      },
    ];
    expect(coverageOf(card, bigger).historyComplete).toBe(false);
  });

  it("finds the earliest start however the rows arrive", () => {
    // Nothing here guarantees ordering. The ledger returns rows sorted, but
    // this takes an array and must not quietly depend on that.
    const ascending = [
      m("2025-01-10T00:00:00Z", -20_00, 480_00),
      m("2025-06-10T00:00:00Z", -5_00, 475_00),
    ];
    const descending = [...ascending].reverse();
    expect(coverageOf(current, descending).historyFrom).toBe("2025-01-10");
    expect(coverageOf(current, descending)).toEqual(
      coverageOf(current, ascending),
    );
  });

  it("says nothing about an account with no transactions", () => {
    // Absent, not false. There is no earliest balance to test, and reporting
    // "incomplete" would claim history is missing before a date that does not
    // exist. Same rule as isCard in #29.
    const c = coverageOf(current, []);
    expect(c.historyComplete).toBeUndefined();
    expect(c.historyFrom).toBeUndefined();
  });
});

describe("when a household total becomes trustworthy", () => {
  it("is the latest start among the incomplete accounts", () => {
    expect(
      completeFrom([
        { accountId: "a", historyFrom: "2021-08-09", historyComplete: false },
        { accountId: "b", historyFrom: "2025-02-10", historyComplete: false },
        { accountId: "c", historyFrom: "2023-07-16", historyComplete: false },
      ]),
    ).toBe("2025-02-10");
  });

  it("ignores an account that was opened in range, however recent", () => {
    // The whole point of the rule. A card opened last month contributed nothing
    // before it existed, so its absence from earlier totals is correct — and a
    // naive max() over every start date would wrongly cut the chart to a month.
    expect(
      completeFrom([
        { accountId: "old", historyFrom: "2021-08-09", historyComplete: false },
        { accountId: "new", historyFrom: "2026-07-01", historyComplete: true },
      ]),
    ).toBe("2021-08-09");
  });

  it("treats an unknown account as constraining, not as complete", () => {
    // Absent means we could not tell. Assuming complete would draw a total that
    // might be missing an account; assuming incomplete only shortens the chart.
    expect(completeFrom([{ accountId: "a", historyFrom: "2024-01-01" }])).toBe(
      "2024-01-01",
    );
  });

  it("returns nothing when no account constrains the range", () => {
    expect(completeFrom([])).toBeUndefined();
    expect(
      completeFrom([
        { accountId: "a", historyFrom: "2021-01-01", historyComplete: true },
      ]),
    ).toBeUndefined();
    // No start date cannot constrain anything, even though it is not complete.
    expect(completeFrom([{ accountId: "a" }])).toBeUndefined();
  });
});

describe("clamping a requested range", () => {
  const asked = { from: "2021-01-01", to: "2026-08-16" };

  it("narrows a request that reaches back past complete coverage", () => {
    expect(clampToCoverage(asked, "2025-02-10")).toEqual({
      from: "2025-02-10",
      to: "2026-08-16",
    });
  });

  it("leaves a request already inside coverage alone", () => {
    expect(
      clampToCoverage({ from: "2026-01-01", to: "2026-08-16" }, "2025-02-10"),
    ).toEqual({
      from: "2026-01-01",
      to: "2026-08-16",
    });
  });

  it("does not widen a range when nothing constrains it", () => {
    expect(clampToCoverage(asked, undefined)).toEqual(asked);
  });

  it("collapses rather than sliding forward when the range ends before coverage", () => {
    // Asking about 2021 when nothing is complete until 2025 must not quietly
    // answer about 2025 — that is a different question, confidently answered.
    expect(
      clampToCoverage({ from: "2021-01-01", to: "2022-01-01" }, "2025-02-10"),
    ).toEqual({
      from: "2022-01-01",
      to: "2022-01-01",
    });
  });
});

describe("ordering within a single instant", () => {
  it("breaks a tie on the dedup key, so the opening balance is deterministic", () => {
    // Every transaction is stamped midnight, so a timestamp orders nothing within
    // a day. The first transaction of the earliest day decides a current
    // account's opening balance, so "first" has to mean the same thing on every
    // run or the completeness verdict flickers.
    const rows = [
      {
        accountId: "cur",
        timestamp: "2025-01-10T00:00:00Z",
        amount: -20_00,
        dedupKey: "b",
        runningBalance: 80_00,
      },
      {
        accountId: "cur",
        timestamp: "2025-01-10T00:00:00Z",
        amount: -30_00,
        dedupKey: "a",
        runningBalance: 110_00,
      },
    ];
    const forwards = openingBalance(current, rows);
    const backwards = openingBalance(current, [...rows].reverse());
    expect(forwards).toBe(backwards);
    expect(forwards).toBe(140_00);
  });
});
