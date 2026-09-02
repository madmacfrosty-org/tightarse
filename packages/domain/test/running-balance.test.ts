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
import {
  checkRunningBalanceChain,
  dailyPositionChecks,
} from "../src/ledger/running-balance.js";
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
    // Counted exactly, not just "all of them": how many pairs there are and how
    // many can tell the readings apart is the evidence behind the verdict, and a
    // verdict whose evidence is unchecked is a verdict on trust.
    expect(result).toMatchObject({
      pairs: 2,
      discriminating: 2,
      closingMatches: 2,
      openingMatches: 0,
    });
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

  it("orders by timestamp first, not by the dedup key", () => {
    // The keys here sort opposite to the timestamps. Comparing keys first would
    // reverse the ledger and break a chain that is in fact sound — and every
    // other test uses keys that happen to agree with the dates, so nothing else
    // would notice.
    let balance = 100_000;
    const rows: Movement[] = [-1299, -450, 2500].map((amount, i) => {
      balance += amount;
      return {
        accountId: "acc1",
        timestamp: `2026-03-0${i + 1}T00:00:00Z`,
        amount,
        dedupKey: ["n:c", "n:b", "n:a"][i]!,
        runningBalance: balance,
      };
    });

    expect(checkRunningBalanceChain(rows).verdict).toBe("closing");
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

describe("dailyPositionChecks", () => {
  const twoPerDay = (): Movement[] => {
    // Two transactions on each of three days, chained as closing positions.
    let balance = 100_000;
    const rows: Movement[] = [];
    const days = ["2026-03-01", "2026-03-02", "2026-03-03"];
    days.forEach((date, d) => {
      [-1299, -450].forEach((amount, i) => {
        balance += amount;
        rows.push({
          accountId: "acc1",
          timestamp: `${date}T00:00:00Z`,
          amount,
          dedupKey: `n:${d}-${i}`,
          runningBalance: balance,
        });
      });
    });
    return rows;
  };

  it("finds every day agreeing when the balance is a closing position", () => {
    const checks = dailyPositionChecks(twoPerDay());

    expect(checks.map((c) => c.difference)).toEqual([0, 0]);
    expect(checks.map((c) => c.date)).toEqual(["2026-03-02", "2026-03-03"]);
  });

  it("takes the last balance of a day as its close, and sums the whole day", () => {
    const [first] = dailyPositionChecks(twoPerDay());

    expect(first).toMatchObject({ movement: -1749, difference: 0 });
    expect(first!.closing).toBe(first!.previousClosing + first!.movement);
  });

  it("skips the first day, which has nothing to compare against", () => {
    expect(dailyPositionChecks(twoPerDay())).toHaveLength(2);
  });

  it("reports the shortfall when a day's transaction is missing", () => {
    // The first of that day's two, so a later row still carries a balance that
    // reflects the missing one.
    const rows = twoPerDay().filter((m) => m.dedupKey !== "n:1-0");

    const checks = dailyPositionChecks(rows);

    // The balance moved by more than the surviving row explains, by exactly the
    // amount that went missing.
    expect(checks[0]!.difference).toBe(-1299);
  });

  it("cannot see a missing transaction that was the last of its day", () => {
    // Worth stating rather than discovering later: dropping the final row of a
    // day drops its running balance too, and what remains is a shorter chain
    // that is entirely self-consistent. Only a surviving later balance can
    // testify to a gap. `checkRunningBalanceChain` has the same blind spot at
    // the end of the ledger, and reconciliation against a balance reading is
    // what covers it.
    const rows = twoPerDay().filter((m) => m.dedupKey !== "n:1-1");

    expect(dailyPositionChecks(rows)[0]!.difference).toBe(0);
  });

  it("orders the days itself rather than trusting the order it was handed", () => {
    const checks = dailyPositionChecks([...twoPerDay()].reverse());

    expect(checks.map((c) => c.date)).toEqual(["2026-03-02", "2026-03-03"]);
    expect(checks.map((c) => c.difference)).toEqual([0, 0]);
  });

  it("takes the day's close by timestamp order, not by dedup key", () => {
    // Two rows on one day whose keys sort opposite to the order they occurred.
    // The later row is the close; comparing keys first would take the earlier
    // one and invent a discrepancy out of correct data.
    const rows: Movement[] = [
      {
        accountId: "acc1",
        timestamp: "2026-03-01T00:00:00Z",
        amount: -1_000,
        dedupKey: "n:z",
        runningBalance: 99_000,
      },
      {
        accountId: "acc1",
        timestamp: "2026-03-02T00:00:00Z",
        amount: -500,
        dedupKey: "n:b",
        runningBalance: 98_500,
      },
      {
        accountId: "acc1",
        timestamp: "2026-03-02T12:00:00Z",
        amount: -250,
        dedupKey: "n:a",
        runningBalance: 98_250,
      },
    ];

    const [day] = dailyPositionChecks(rows);

    expect(day).toMatchObject({
      date: "2026-03-02",
      previousClosing: 99_000,
      closing: 98_250,
      movement: -750,
      difference: 0,
    });
  });

  it("ignores rows carrying no running balance rather than reading them as zero", () => {
    // The provider marks the field optional on every row, not just on cards, so
    // an account can carry it on some rows and not others. Treating an absent
    // balance as a close would invent a plunge to zero and back.
    const rows: Movement[] = [
      {
        accountId: "acc1",
        timestamp: "2026-03-01T00:00:00Z",
        amount: -1_000,
        dedupKey: "n:1",
        runningBalance: 99_000,
      },
      {
        accountId: "acc1",
        timestamp: "2026-03-02T00:00:00Z",
        amount: -500,
        dedupKey: "n:2",
      },
      {
        accountId: "acc1",
        timestamp: "2026-03-02T12:00:00Z",
        amount: -250,
        dedupKey: "n:3",
        runningBalance: 98_250,
      },
    ];

    const [day] = dailyPositionChecks(rows);

    // The unbalanced row contributes neither a close nor a movement, so the day
    // is short by exactly it — which is the shape of a real gap, reported
    // rather than smoothed over.
    expect(day).toMatchObject({
      date: "2026-03-02",
      previousClosing: 99_000,
      closing: 98_250,
      movement: -250,
      difference: -500,
    });
  });

  it("has nothing to say about an account with no running balances", () => {
    expect(
      dailyPositionChecks([
        { accountId: "card", timestamp: "2026-03-01T00:00:00Z", amount: -1299, dedupKey: "n:1" },
      ]),
    ).toEqual([]);
  });
});
