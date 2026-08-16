import { describe, it, expect } from "vitest";
import { accountSeries, daysBetween, netPositionSeries, type AccountFacts, type Movement } from "./balances";

// Distinct and ascending, mirroring the ledger's tiebreak within a timestamp.
let cardKey = 0;

const days = (from: string, to: string) => daysBetween(from, to);

describe("days in a range", () => {
  it("includes both ends", () => {
    // The contract says ranges are inclusive at both ends, so a single day is
    // one point and not zero.
    expect(days("2026-03-01", "2026-03-03")).toEqual(["2026-03-01", "2026-03-02", "2026-03-03"]);
    expect(days("2026-03-01", "2026-03-01")).toEqual(["2026-03-01"]);
  });

  it("crosses a month, a year and a leap day without losing one", () => {
    expect(days("2026-12-30", "2027-01-02")).toHaveLength(4);
    // 2028 is a leap year: February has 29 days.
    expect(days("2028-02-28", "2028-03-01")).toEqual(["2028-02-28", "2028-02-29", "2028-03-01"]);
  });
});

describe("a current account's series", () => {
  const account: AccountFacts = { accountId: "cur", isCard: false };
  let seq = 0;
  const m = (ts: string, amount: number, runningBalance: number): Movement => ({
    accountId: "cur",
    timestamp: ts,
    amount,
    // Ascending with declaration order, so "later in the array" and "later by
    // dedup key" agree and the fixtures read the way they behave.
    dedupKey: `d${String(seq++).padStart(4, "0")}`,
    runningBalance,
  });

  it("reads the provider's running total rather than adding up amounts", () => {
    // The provider's own figure is authoritative and is what reconciliation
    // checks. Re-deriving it from amounts would drift on the first transaction
    // we did not receive.
    const rows = [m("2026-03-01T00:00:00Z", -10_00, 90_00), m("2026-03-03T00:00:00Z", -20_00, 70_00)];
    expect(accountSeries(account, rows, days("2026-03-01", "2026-03-04"))).toEqual([
      90_00,
      90_00,
      70_00,
      70_00,
    ]);
  });

  it("carries the balance across a quiet day rather than dropping to zero", () => {
    // A fortnight with no spending is a flat line. Zero would read as an
    // emptied account, which is a different and alarming thing.
    const rows = [m("2026-03-01T00:00:00Z", -10_00, 90_00)];
    expect(accountSeries(account, rows, days("2026-03-01", "2026-03-05"))).toEqual([
      90_00, 90_00, 90_00, 90_00, 90_00,
    ]);
  });

  it("reports nothing before the account has any data", () => {
    // Distinct from zero. A day the account did not report is not a day it held
    // nothing, and the difference is what stops a total being drawn short.
    const rows = [m("2026-03-03T00:00:00Z", -10_00, 90_00)];
    expect(accountSeries(account, rows, days("2026-03-01", "2026-03-03"))).toEqual([
      undefined,
      undefined,
      90_00,
    ]);
  });

  it("prefers the live balance once it is more recent than the last transaction", () => {
    // A current account's running balance is only as fresh as its last settled
    // transaction. On a quiet couple of days the live balance has moved on, and
    // taking the stale one made the household's series end £56 below the figure
    // on the account tiles — a small, entirely explainable difference that
    // still reads as a bug when two panels disagree.
    const rows = [m("2026-03-01T00:00:00Z", -10_00, 90_00)];
    const withLive: AccountFacts = { ...account, currentBalance: 85_00, balanceAsOf: "2026-03-03" };
    expect(accountSeries(withLive, rows, days("2026-03-01", "2026-03-04"))).toEqual([
      90_00,
      90_00,
      85_00,
      85_00,
    ]);
  });

  it("does not let the live balance leak into a range that ends before it", () => {
    // The reason it is an observation with a date rather than a special case
    // for "today": a range ending last month must not be answered with this
    // morning's balance.
    const rows = [m("2026-03-01T00:00:00Z", -10_00, 90_00)];
    const withLive: AccountFacts = { ...account, currentBalance: 85_00, balanceAsOf: "2026-03-10" };
    expect(accountSeries(withLive, rows, days("2026-03-01", "2026-03-02"))).toEqual([90_00, 90_00]);
  });

  it("gives the same series however the rows arrive", () => {
    // Same reason as coverage: this takes an array, and depending on the
    // ledger's ordering without saying so is how a function starts working
    // only when called one particular way.
    const rows = [
      m("2026-03-01T00:00:00Z", -10_00, 90_00),
      m("2026-03-03T00:00:00Z", -20_00, 70_00),
      m("2026-03-05T00:00:00Z", -5_00, 65_00),
    ];
    const asc = accountSeries(account, rows, days("2026-03-01", "2026-03-05"));
    const desc = accountSeries(account, [...rows].reverse(), days("2026-03-01", "2026-03-05"));
    expect(desc).toEqual(asc);
    expect(asc).toEqual([90_00, 90_00, 70_00, 70_00, 65_00]);
  });

  it("orders the live balance against transactions by date, not by arrival", () => {
    const rows = [m("2026-03-04T00:00:00Z", -10_00, 60_00), m("2026-03-01T00:00:00Z", -10_00, 90_00)];
    const withLive: AccountFacts = { ...account, currentBalance: 70_00, balanceAsOf: "2026-03-02" };
    // 90 on the 1st, live 70 on the 2nd, then the transaction on the 4th.
    expect(accountSeries(withLive, rows, days("2026-03-01", "2026-03-04"))).toEqual([
      90_00,
      70_00,
      70_00,
      60_00,
    ]);
  });

  it("takes the last balance of a day when several land at the same instant", () => {
    // Every transaction is stamped midnight, so the timestamp alone does not
    // order them. "The last running balance of the day" is only meaningful if
    // "last" is deterministic — the ledger's sort key breaks the tie and this
    // has to match, or the chart moves between identical requests.
    const rows = [
      m("2026-03-01T00:00:00Z", -10_00, 90_00),
      m("2026-03-01T00:00:00Z", -20_00, 70_00),
    ];
    const forwards = accountSeries(account, rows, days("2026-03-01", "2026-03-01"));
    const backwards = accountSeries(account, [...rows].reverse(), days("2026-03-01", "2026-03-01"));
    expect(forwards).toEqual(backwards);
  });
});

describe("a card's series", () => {
  // Cards carry no running balance at all — 0 of 2,287 across the household —
  // so the only route is backwards from what is owed today.
  const card: AccountFacts = { accountId: "card", isCard: true, currentBalance: 50_00 };
  let cardSeq = 0;
  const m = (ts: string, amount: number): Movement => ({
    accountId: "card",
    timestamp: ts,
    amount,
    dedupKey: `c${String(cardSeq++).padStart(4, "0")}`,
  });

  it("unwinds today's balance through everything that happened since", () => {
    // Owes £50 now. £20 of that was spent on the 3rd, so on the 2nd it owed £30.
    const rows = [m("2026-03-01T00:00:00Z", -30_00), m("2026-03-03T00:00:00Z", -20_00)];
    expect(accountSeries(card, rows, days("2026-03-01", "2026-03-03"))).toEqual([30_00, 30_00, 50_00]);
  });

  it("reports nothing when the current balance is unknown", () => {
    // There is no anchor to unwind from, and inventing one would produce a
    // plausible line that is wrong by the whole balance.
    const rows = [m("2026-03-01T00:00:00Z", -30_00)];
    expect(accountSeries({ accountId: "card", isCard: true }, rows, days("2026-03-01", "2026-03-01"))).toEqual([
      undefined,
    ]);
  });
});

describe("the household's net position", () => {
  it("subtracts card debt rather than adding it", () => {
    // The £567.90 bug: a card's balance is what is OWED, reported positive, and
    // adding it overstates the household by twice the debt.
    const accounts: AccountFacts[] = [
      { accountId: "cur", isCard: false },
      { accountId: "card", isCard: true, currentBalance: 200_00 },
    ];
    const movements: Movement[] = [
      { accountId: "cur", dedupKey: "cur-2026-03-01", timestamp: "2026-03-01T00:00:00Z", amount: -10_00, runningBalance: 1_000_00 },
      { accountId: "card", dedupKey: `c${cardKey++}`, timestamp: "2026-03-01T00:00:00Z", amount: -200_00 },
    ];
    expect(netPositionSeries(accounts, movements, days("2026-03-01", "2026-03-01"))).toEqual([
      { date: "2026-03-01", net: 800_00 },
    ]);
  });

  it("omits an account that has no data for a day rather than counting it as zero", () => {
    // Safe only because the range is clamped to complete coverage before it
    // gets here. The clamp is what makes this contribute-nothing rule correct
    // rather than a quiet understatement — see coverage.ts.
    const accounts: AccountFacts[] = [
      { accountId: "old", isCard: false },
      { accountId: "new", isCard: false },
    ];
    const movements: Movement[] = [
      { accountId: "old", dedupKey: "old-2026-03-01", timestamp: "2026-03-01T00:00:00Z", amount: -10_00, runningBalance: 100_00 },
      { accountId: "new", dedupKey: "new-2026-03-02", timestamp: "2026-03-02T00:00:00Z", amount: -10_00, runningBalance: 50_00 },
    ];
    expect(netPositionSeries(accounts, movements, days("2026-03-01", "2026-03-02"))).toEqual([
      { date: "2026-03-01", net: 100_00 },
      { date: "2026-03-02", net: 150_00 },
    ]);
  });

  it("gives a point for every day, including ones with no activity anywhere", () => {
    const accounts: AccountFacts[] = [{ accountId: "cur", isCard: false }];
    const movements: Movement[] = [
      { accountId: "cur", dedupKey: "cur-2026-03-01", timestamp: "2026-03-01T00:00:00Z", amount: -10_00, runningBalance: 100_00 },
    ];
    const series = netPositionSeries(accounts, movements, days("2026-03-01", "2026-03-10"));
    expect(series).toHaveLength(10);
    expect(series.every((p) => p.net === 100_00)).toBe(true);
  });
});
