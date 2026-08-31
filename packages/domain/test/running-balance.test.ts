/**
 * Recovering what `running_balance` means from the data.
 *
 * The provider does not document it and three places in this codebase assume
 * it. These tests are the specification of the check that decides, so they are
 * written from the two hypotheses rather than from the implementation.
 *
 * Every figure is invented.
 */

import { describe, it, expect } from "vitest";
import { checkRunningBalanceChain } from "../src/ledger/running-balance.js";
import type { Movement } from "../src/reporting/balances.js";

/** A movement whose running balance is the position *after* it — the closing reading. */
const closingChain = (
  opening: number,
  amounts: readonly number[],
): Movement[] => {
  let balance = opening;
  return amounts.map((amount, i) => {
    balance += amount;
    return {
      accountId: "acc1",
      timestamp: `2026-03-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      amount,
      dedupKey: `n:${i}`,
      runningBalance: balance,
    };
  });
};

/** The same amounts, with the running balance being the position *before* each. */
const openingChain = (
  opening: number,
  amounts: readonly number[],
): Movement[] => {
  let balance = opening;
  return amounts.map((amount, i) => {
    const before = balance;
    balance += amount;
    return {
      accountId: "acc1",
      timestamp: `2026-03-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      amount,
      dedupKey: `n:${i}`,
      runningBalance: before,
    };
  });
};

describe("checkRunningBalanceChain", () => {
  it("says closing when each balance is the position after its transaction", () => {
    const result = checkRunningBalanceChain(closingChain(100_000, [-1299, -450, 2500]));

    expect(result.verdict).toBe("closing");
    expect(result.closingMatches).toBe(result.pairs);
  });

  it("says opening when each balance is the position before its transaction", () => {
    const result = checkRunningBalanceChain(openingChain(100_000, [-1299, -450, 2500]));

    expect(result.verdict).toBe("opening");
    expect(result.openingMatches).toBe(result.pairs);
  });

  it("says ambiguous when every consecutive pair carries the same amount", () => {
    // Both readings predict the same chain, so the data cannot distinguish them.
    const result = checkRunningBalanceChain(closingChain(100_000, [-1000, -1000, -1000]));

    expect(result.verdict).toBe("ambiguous");
    expect(result.discriminating).toBe(0);
  });

  it("says inconsistent when the chain does not hold either way", () => {
    // What a missing transaction looks like: the balance jumps by more than the
    // row that is present can explain.
    const rows = closingChain(100_000, [-1299, -450]);
    rows[1] = { ...rows[1]!, runningBalance: rows[1]!.runningBalance! - 9_999 };

    expect(checkRunningBalanceChain(rows).verdict).toBe("inconsistent");
  });

  it("refuses to call a majority the answer, because one break is a break", () => {
    const rows = closingChain(100_000, [-1299, -450, 2500, -700]);
    rows[2] = { ...rows[2]!, runningBalance: rows[2]!.runningBalance! + 1 };

    const result = checkRunningBalanceChain(rows);

    expect(result.verdict).toBe("inconsistent");
    expect(result.closingMatches).toBeGreaterThan(0);
    expect(result.closingMatches).toBeLessThan(result.pairs);
  });

  it("is insufficient with nothing to compare", () => {
    expect(checkRunningBalanceChain([]).verdict).toBe("insufficient");
    expect(checkRunningBalanceChain(closingChain(0, [-100])).verdict).toBe(
      "insufficient",
    );
  });

  it("is insufficient for a card, which carries no running balance at all", () => {
    const card: Movement[] = [
      { accountId: "card", timestamp: "2026-03-01T00:00:00Z", amount: -1299, dedupKey: "n:1" },
      { accountId: "card", timestamp: "2026-03-02T00:00:00Z", amount: -450, dedupKey: "n:2" },
    ];

    const result = checkRunningBalanceChain(card);

    expect(result.verdict).toBe("insufficient");
    expect(result.pairs).toBe(0);
  });

  it("orders the rows itself rather than trusting the order it was handed", () => {
    const ordered = closingChain(100_000, [-1299, -450, 2500]);

    expect(checkRunningBalanceChain([...ordered].reverse()).verdict).toBe("closing");
  });

  it("breaks ties on the dedup key, because a day's rows share a timestamp", () => {
    // Every timestamp midnight, which is what the real ledger looks like.
    let balance = 100_000;
    const rows: Movement[] = [-1299, -450, 2500].map((amount, i) => {
      balance += amount;
      return {
        accountId: "acc1",
        timestamp: "2026-03-01T00:00:00Z",
        amount,
        dedupKey: `n:${i}`,
        runningBalance: balance,
      };
    });

    expect(checkRunningBalanceChain([...rows].reverse()).verdict).toBe("closing");
  });
});
