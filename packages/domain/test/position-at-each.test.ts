/**
 * The balance at a transaction, not on a day.
 *
 * #33's whole question is "what was the balance at this transaction", and a
 * daily position cannot answer it: every row is stamped midnight and the real
 * ledger holds up to 47 sharing one day. The order is the ledger's own, so the
 * answer is the same on every request.
 *
 * Every figure is invented.
 */

import { describe, it, expect } from "vitest";
import { positionAtEach, type Movement } from "../src/reporting/balances.js";

const m = (
  dedupKey: string,
  amount: number,
  over: Partial<Movement> = {},
): Movement => ({
  accountId: "acc",
  timestamp: "2026-03-01T00:00:00Z",
  amount,
  dedupKey,
  ...over,
});

const account = { accountId: "acc", isCard: false };

describe("the position after each transaction", () => {
  it("runs through a single day in the ledger's order, not the array's", () => {
    // All three at midnight, handed over in the wrong order. `dedupKey` breaks
    // the tie, so the answer is b, then c, then a regardless.
    const rows = [
      m("c", -30_00),
      m("a", 500_00, { runningBalance: 500_00 }),
      m("b", -20_00),
    ];
    const at = positionAtEach(account, rows);
    expect(at.get("a")).toBe(500_00);
    expect(at.get("b")).toBe(480_00);
    expect(at.get("c")).toBe(450_00);
  });

  it("gives the same answer however the rows arrive", () => {
    const rows = [m("a", 500_00, { runningBalance: 500_00 }), m("b", -20_00)];
    const forwards = positionAtEach(account, rows);
    const backwards = positionAtEach(account, [...rows].reverse());
    expect([...backwards.entries()]).toEqual([...forwards.entries()]);
  });

  it("agrees with the provider's own running balance where it has one", () => {
    // The check that matters: our arithmetic reproduces theirs. Where it does
    // not, the ledger and the bank disagree — which is what #133 surfaces.
    const rows = [
      m("a", 500_00, { runningBalance: 500_00 }),
      m("b", -20_00, { runningBalance: 480_00 }),
      m("c", -30_00, { runningBalance: 450_00 }),
    ];
    const at = positionAtEach(account, rows);
    for (const r of rows) expect(at.get(r.dedupKey)).toBe(r.runningBalance);
  });

  it("reports a card as what is owed, the way the wire does", () => {
    // Spending on a card is a negative amount; the balance is what is owed and
    // is carried positive. Same flip `accountSeries` applies.
    const card = { accountId: "acc", isCard: true, currentBalance: 50_00 };
    const at = positionAtEach(card, [m("a", -30_00), m("b", -20_00)]);
    expect(at.get("a")).toBe(30_00);
    expect(at.get("b")).toBe(50_00);
  });

  it("leaves a pending row out rather than interleaving it", () => {
    // It has an amount and no place in the provider's chain. Counting it would
    // make every figure after it disagree with the bank for a reason that is
    // nothing to do with the ledger being wrong.
    const at = positionAtEach(account, [
      m("a", 500_00, { runningBalance: 500_00 }),
      m("b", -20_00, { status: "pending" }),
      m("c", -30_00),
    ]);
    expect(at.has("b")).toBe(false);
    expect(at.get("c")).toBe(470_00);
  });

  it("has nothing to say about an account it cannot open", () => {
    expect(positionAtEach(account, []).size).toBe(0);
    expect(positionAtEach({ accountId: "a", isCard: true }, [m("a", -1_00)]).size).toBe(0);
  });
});
