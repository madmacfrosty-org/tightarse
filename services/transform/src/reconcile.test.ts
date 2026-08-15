import { describe, it, expect } from "vitest";
import { reconcileAccount, reconciliationMetrics, type Movement, type Reading } from "./reconcile";

/**
 * The check that catches a missing transaction.
 *
 * Nothing detects that today. A transaction the provider never returned, or one
 * we failed to write, silently corrupts every balance derived before it — and
 * the numbers stay plausible, which is the worst kind of wrong for money.
 */

const reading = (fetchedAt: string, balance: number): Reading => ({
  accountId: "acc-1",
  fetchedAt,
  balance,
});

const movement = (timestamp: string, amount: number): Movement => ({ timestamp, amount });

describe("balances that add up", () => {
  it("accepts a window where the transactions explain the movement", () => {
    // £100 on the 1st, £90 on the 3rd, and a £10 payment on the 2nd.
    const result = reconcileAccount(
      "acc-1",
      [reading("2026-01-01T05:00:00.000Z", 100_00), reading("2026-01-03T05:00:00.000Z", 90_00)],
      [movement("2026-01-02T00:00:00Z", -10_00)],
    );
    expect(result.checked).toBe(1);
    expect(result.breaks).toHaveLength(0);
  });

  it("accepts a window with no transactions and no movement", () => {
    // A dormant account. Nothing happened and the balance did not move, which
    // is a successful check rather than an absence of one.
    const result = reconcileAccount(
      "acc-1",
      [reading("2026-01-01T05:00:00.000Z", 100_00), reading("2026-01-03T05:00:00.000Z", 100_00)],
      [],
    );
    expect(result).toMatchObject({ checked: 1, breaks: [] });
  });

  it("sums several transactions across the window", () => {
    const result = reconcileAccount(
      "acc-1",
      [reading("2026-01-01T05:00:00.000Z", 100_00), reading("2026-01-05T05:00:00.000Z", 65_00)],
      [
        movement("2026-01-02T00:00:00Z", -20_00),
        movement("2026-01-03T00:00:00Z", -25_00),
        movement("2026-01-04T00:00:00Z", 10_00),
      ],
    );
    expect(result.breaks).toHaveLength(0);
  });

  it("works for a card, where both readings are negative", () => {
    // Cards are the reason this check exists: they carry no running balance, so
    // this is the only thing that can verify them. Owed £500, then owed £560,
    // with a £60 purchase between.
    const result = reconcileAccount(
      "card-1",
      [reading("2026-01-01T05:00:00.000Z", -500_00), reading("2026-01-03T05:00:00.000Z", -560_00)],
      [movement("2026-01-02T00:00:00Z", -60_00)],
    );
    expect(result.breaks).toHaveLength(0);
  });
});

describe("balances that do not", () => {
  it("reports a break when a transaction is missing", () => {
    // The failure this exists for. The bank says £30 left; we can only account
    // for £10, so £20 of movement has no transaction behind it.
    const result = reconcileAccount(
      "acc-1",
      [reading("2026-01-01T05:00:00.000Z", 100_00), reading("2026-01-03T05:00:00.000Z", 70_00)],
      [movement("2026-01-02T00:00:00Z", -10_00)],
    );
    expect(result.breaks).toHaveLength(1);
    expect(result.breaks[0]).toMatchObject({
      accountId: "acc-1",
      reported: -30_00,
      observed: -10_00,
      discrepancy: -20_00,
      movements: 1,
    });
  });

  it("reports a break when we hold a transaction the bank did not count", () => {
    // The other direction, and just as wrong: a duplicate, or one attributed to
    // the wrong account.
    const result = reconcileAccount(
      "acc-1",
      [reading("2026-01-01T05:00:00.000Z", 100_00), reading("2026-01-03T05:00:00.000Z", 100_00)],
      [movement("2026-01-02T00:00:00Z", -10_00)],
    );
    expect(result.breaks[0]).toMatchObject({ reported: 0, observed: -10_00, discrepancy: 10_00 });
  });

  it("reports a break when the movement is the right size in the wrong direction", () => {
    // Direction is the whole point. The balance rose by £30 while our
    // transactions say £30 left — a check comparing magnitudes would call that
    // healthy, and it is as wrong as money can get in this ledger.
    const result = reconcileAccount(
      "acc-1",
      [reading("2026-01-01T05:00:00.000Z", 100_00), reading("2026-01-03T05:00:00.000Z", 130_00)],
      [movement("2026-01-02T00:00:00Z", -30_00)],
    );
    expect(result.breaks).toHaveLength(1);
    expect(result.breaks[0]).toMatchObject({ reported: 30_00, observed: -30_00, discrepancy: 60_00 });
  });

  it("names both readings, so the window can be investigated", () => {
    const result = reconcileAccount(
      "acc-1",
      [reading("2026-01-01T05:00:00.000Z", 100_00), reading("2026-01-03T05:00:00.000Z", 50_00)],
      [],
    );
    expect(result.breaks[0]).toMatchObject({
      previousFetchedAt: "2026-01-01T05:00:00.000Z",
      fetchedAt: "2026-01-03T05:00:00.000Z",
    });
  });

  it("checks the whole span once, not each consecutive pair", () => {
    // Consecutive pairs were tried and are wrong: a transaction's date is not
    // when it settled, so one dated the 12th can land in the balance on the
    // 14th. That moves transactions between adjacent windows without moving
    // them out of the total. Against real data the pairwise version reported 6
    // breaks in 20 checks with nothing actually missing, while every account
    // reconciled exactly over its full series.
    const result = reconcileAccount(
      "acc-1",
      [
        reading("2026-01-01T05:00:00.000Z", 100_00),
        reading("2026-01-03T05:00:00.000Z", 50_00),
        reading("2026-01-05T05:00:00.000Z", 10_00),
      ],
      [],
    );
    expect(result.checked).toBe(1);
    expect(result.breaks).toHaveLength(1);
    expect(result.breaks[0]).toMatchObject({
      previousFetchedAt: "2026-01-01T05:00:00.000Z",
      fetchedAt: "2026-01-05T05:00:00.000Z",
      reported: -90_00,
    });
  });

  it("ignores how transactions are distributed inside the span", () => {
    // The property that makes this robust to settlement lag: only the total
    // matters, so a transaction landing in a different window than its date
    // suggests changes nothing.
    const readings = [reading("2026-01-01T05:00:00.000Z", 100_00), reading("2026-01-05T05:00:00.000Z", 70_00)];
    const early = reconcileAccount("acc-1", readings, [movement("2026-01-02T00:00:00Z", -30_00)]);
    const late = reconcileAccount("acc-1", readings, [movement("2026-01-04T00:00:00Z", -30_00)]);
    const split = reconcileAccount("acc-1", readings, [
      movement("2026-01-02T00:00:00Z", -10_00),
      movement("2026-01-04T00:00:00Z", -20_00),
    ]);
    expect(early.breaks).toHaveLength(0);
    expect(late.breaks).toHaveLength(0);
    expect(split.breaks).toHaveLength(0);
  });
});

describe("which transactions fall in a window", () => {
  it("includes the later reading's own day", () => {
    // The assumption, stated: a reading taken on day D includes every
    // transaction dated D. If that is wrong, this check is how we find out.
    const result = reconcileAccount(
      "acc-1",
      [reading("2026-01-01T05:00:00.000Z", 100_00), reading("2026-01-03T05:00:00.000Z", 90_00)],
      [movement("2026-01-03T00:00:00Z", -10_00)],
    );
    expect(result.breaks).toHaveLength(0);
  });

  it("excludes the earlier reading's own day, which the earlier reading already counted", () => {
    // Counting it twice would report a break on every ordinary window.
    const result = reconcileAccount(
      "acc-1",
      [reading("2026-01-01T05:00:00.000Z", 100_00), reading("2026-01-03T05:00:00.000Z", 100_00)],
      [movement("2026-01-01T00:00:00Z", -10_00)],
    );
    expect(result.breaks).toHaveLength(0);
  });

  it("excludes transactions after the later reading", () => {
    const result = reconcileAccount(
      "acc-1",
      [reading("2026-01-01T05:00:00.000Z", 100_00), reading("2026-01-03T05:00:00.000Z", 100_00)],
      [movement("2026-01-09T00:00:00Z", -10_00)],
    );
    expect(result.breaks).toHaveLength(0);
  });

  it("skips a pair taken on the same day rather than reporting it", () => {
    // Two readings on one day cannot be checked: the transactions between them
    // are a subset of that day's and nothing says which. A limit of the data,
    // not a discrepancy — reporting it would cry wolf on every re-run.
    const result = reconcileAccount(
      "acc-1",
      [reading("2026-01-01T05:00:00.000Z", 100_00), reading("2026-01-01T18:00:00.000Z", 40_00)],
      [],
    );
    expect(result).toMatchObject({ checked: 0, breaks: [] });
  });
});

describe("what it does with awkward input", () => {
  it("orders readings itself, so a caller cannot get it wrong by scanning", () => {
    // A scan returns rows in whatever order it likes. Trusting that would
    // produce a confidently wrong answer rather than an error.
    const forwards = reconcileAccount(
      "acc-1",
      [reading("2026-01-01T05:00:00.000Z", 100_00), reading("2026-01-03T05:00:00.000Z", 90_00)],
      [movement("2026-01-02T00:00:00Z", -10_00)],
    );
    const backwards = reconcileAccount(
      "acc-1",
      [reading("2026-01-03T05:00:00.000Z", 90_00), reading("2026-01-01T05:00:00.000Z", 100_00)],
      [movement("2026-01-02T00:00:00Z", -10_00)],
    );
    expect(backwards).toEqual(forwards);
  });

  it("checks nothing for an account with a single reading", () => {
    // The normal state of a newly connected account, and of every account until
    // a second sync has run. Nothing to check is not a failure.
    expect(reconcileAccount("acc-1", [reading("2026-01-01T05:00:00.000Z", 1)], [])).toMatchObject({
      checked: 0,
      breaks: [],
    });
  });

  it("checks nothing for an account with no readings at all", () => {
    expect(reconcileAccount("acc-1", [], [])).toMatchObject({ checked: 0, breaks: [] });
  });
});

describe("what gets emitted", () => {
  const broken = reconcileAccount(
    "x",
    [reading("2026-01-01T05:00:00.000Z", 100_00), reading("2026-01-03T05:00:00.000Z", 50_00)],
    [],
  );
  const clean = reconcileAccount(
    "y",
    [reading("2026-01-01T05:00:00.000Z", 100_00), reading("2026-01-03T05:00:00.000Z", 100_00)],
    [],
  );

  it("splits breaks by card, so an alarm can tell where the problem is", () => {
    // A single total would say something is wrong without saying where, and an
    // alarm that cannot tell a card from an account is how the permanently
    // firing alarm in 927c593 happened.
    expect(
      reconciliationMetrics([
        { result: broken, isCard: true },
        { result: clean, isCard: false },
      ]),
    ).toMatchObject({ ReconciliationBreaksCard: 1, ReconciliationBreaksAccount: 0 });
  });

  it("counts how many checks ran, so no checks is not mistaken for no breaks", () => {
    // An account with one reading has nothing to check yet. Emitting only
    // breaks would make that indistinguishable from a healthy ledger.
    expect(reconciliationMetrics([{ result: clean, isCard: false }])).toMatchObject({
      ReconciliationsChecked: 1,
      ReconciliationBreaksAccount: 0,
    });
    expect(reconciliationMetrics([])).toMatchObject({ ReconciliationsChecked: 0 });
  });
});
