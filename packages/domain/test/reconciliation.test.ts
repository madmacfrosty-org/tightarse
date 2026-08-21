import { describe, it, expect } from "vitest";
import { reconcileAccount, type ReconciliationMovement, type Reading } from "../src/ledger/reconciliation.js";

/**
 * The check that catches a missing transaction.
 *
 * Nothing detects that today. A transaction the provider never returned, or one
 * we failed to write, silently corrupts every balance derived before it — and
 * the numbers stay plausible, which is the worst kind of wrong for money.
 */

/**
 * `asOf` is what everything orders and windows on — the provider's own
 * timestamp where it gave one. Equal to the fetch time here unless a test is
 * specifically about the two differing.
 */
const reading = (asOf: string, balance: number, fetchedAt = asOf): Reading => ({
  accountId: "acc-1",
  asOf,
  fetchedAt,
  balance,
});

const movement = (timestamp: string, amount: number): ReconciliationMovement => ({ timestamp, amount });

/** A transaction dated `timestamp` that we did not hold until `firstSeenAt`. */
const settledLate = (timestamp: string, amount: number, firstSeenAt: string): ReconciliationMovement => ({
  timestamp,
  amount,
  firstSeenAt,
});

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

describe("transactions that settle after a reading was taken", () => {
  /**
   * The real break, reduced.
   *
   * An Amex connected on 16 August: four transactions dated the 15th and 16th
   * were absent from its settled feed that day and present by the 20th, £56.59,
   * matching the discrepancy to the penny. They moved the balance between two
   * readings while their dates sat outside the window, and the alarm stayed open
   * for three days over money that was fully accounted for.
   *
   * Dates here are after PROVENANCE_TRUSTED_FROM, because first-seen only means
   * anything on rows written since it became write-once.
   */
  it("counts one we did not hold when the window opened", () => {
    const result = reconcileAccount(
      "acc-1",
      [reading("2026-09-01T16:22:00.000Z", -100_00), reading("2026-09-05T05:00:00.000Z", -156_59)],
      [settledLate("2026-09-01T00:00:00Z", -56_59, "2026-09-03T05:00:00.000Z")],
    );
    expect(result.breaks).toHaveLength(0);
    expect(result.checked).toBe(1);
  });

  it("still counts it toward the movements the break would report", () => {
    // A break naming zero movements over a four-day window reads as "we hold
    // nothing", which sends someone looking for the wrong problem.
    const result = reconcileAccount(
      "acc-1",
      [reading("2026-09-01T16:22:00.000Z", -100_00), reading("2026-09-05T05:00:00.000Z", -200_00)],
      [settledLate("2026-09-01T00:00:00Z", -56_59, "2026-09-03T05:00:00.000Z")],
    );
    expect(result.breaks[0]!.movements).toBe(1);
  });

  it("does not count one we already held, however it is dated", () => {
    // First seen before the reading, so that balance included it. Counting it
    // again would invent a discrepancy the other way.
    const result = reconcileAccount(
      "acc-1",
      [reading("2026-09-03T05:00:00.000Z", -100_00), reading("2026-09-05T05:00:00.000Z", -100_00)],
      [settledLate("2026-09-01T00:00:00Z", -56_59, "2026-09-02T05:00:00.000Z")],
    );
    expect(result.breaks).toHaveLength(0);
  });

  it("treats a row with no provenance as one we already had", () => {
    // Rows written before provenance became write-once carry no first-seen. The
    // safe reading is the one the check made before this existed: assume it was
    // there. Guessing the other way would clear real breaks on old data.
    const result = reconcileAccount(
      "acc-1",
      [reading("2026-09-01T16:22:00.000Z", -100_00), reading("2026-09-05T05:00:00.000Z", -156_59)],
      [movement("2026-09-01T00:00:00Z", -56_59)],
    );
    expect(result.breaks).toHaveLength(1);
    expect(result.breaks[0]!.discrepancy).toBe(-56_59);
  });

  it("ignores a first-seen from before the value meant first seen", () => {
    // The regression this cost: on the day it shipped, one break became six.
    // Every row the rolling window had re-ingested carried a last-write timestamp
    // days after it arrived, so the whole ledger looked like it had just settled.
    const result = reconcileAccount(
      "acc-1",
      [reading("2026-08-16T16:22:00.000Z", -100_00), reading("2026-08-20T05:00:00.000Z", -156_59)],
      [settledLate("2026-08-15T00:00:00Z", -56_59, "2026-08-18T05:00:00.000Z")],
    );
    expect(result.breaks).toHaveLength(1);
    expect(result.breaks[0]!.discrepancy).toBe(-56_59);
  });

  it("still catches genuinely missing money on an account with late settlers", () => {
    // The point of the whole check. One late settler explains £56.59; the balance
    // moved by £96.59, so £40 is unaccounted for and must still be reported.
    const result = reconcileAccount(
      "acc-1",
      [reading("2026-09-01T16:22:00.000Z", -100_00), reading("2026-09-05T05:00:00.000Z", -196_59)],
      [settledLate("2026-09-01T00:00:00Z", -56_59, "2026-09-03T05:00:00.000Z")],
    );
    expect(result.breaks).toHaveLength(1);
    expect(result.breaks[0]!.discrepancy).toBe(-40_00);
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
      previousAsOf: "2026-01-01T05:00:00.000Z",
      asOf: "2026-01-03T05:00:00.000Z",
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
      previousAsOf: "2026-01-01T05:00:00.000Z",
      asOf: "2026-01-05T05:00:00.000Z",
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

describe("ordering by when the balance was true", () => {
  it("orders on asOf, not on when we happened to ask", async () => {
    // A cached reading can be fetched later while describing an earlier moment,
    // so the two orders can disagree. Ordering on the fetch time would then put
    // the span backwards and report a break on a perfectly sound account.
    //
    // The staleness here is larger than anything measured — the worst real card
    // reading was 32 minutes — but the ordering logic is what is under test, and
    // a smaller gap would not separate the two orders across a day boundary.
    const fresh = reading("2026-01-02T05:00:00.000Z", 90_00, "2026-01-02T05:00:00.000Z");
    const stale = reading("2026-01-01T05:00:00.000Z", 100_00, "2026-01-05T05:00:00.000Z");

    const result = reconcileAccount("acc-1", [fresh, stale], [movement("2026-01-02T00:00:00Z", -10_00)]);

    // Oldest by asOf is the stale one, newest is the fresh one.
    expect(result.breaks).toHaveLength(0);
    expect(result.checked).toBe(1);
  });

  it("marks the row identified by both halves of its key", () => {
    // The row is keyed on asOf and fetchedAt together, so a break has to carry
    // both or the mark lands on nothing.
    const result = reconcileAccount(
      "acc-1",
      [
        reading("2026-01-01T05:00:00.000Z", 100_00, "2026-01-01T05:00:00.000Z"),
        reading("2026-01-03T04:28:00.000Z", 50_00, "2026-01-03T05:00:00.000Z"),
      ],
      [],
    );
    expect(result.breaks[0]).toMatchObject({
      asOf: "2026-01-03T04:28:00.000Z",
      fetchedAt: "2026-01-03T05:00:00.000Z",
      previousAsOf: "2026-01-01T05:00:00.000Z",
    });
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

/**
 * The exact boundaries of the late-settler rule.
 *
 * Every one of these was a mutant that survived: the rule was written, the
 * behaviour was right, and nothing in the suite would have noticed if a `>` had
 * become a `>=`. That matters more here than anywhere else in the codebase,
 * because getting this rule wrong took the live break count from 1 to 6, and
 * the tests were green while it did.
 */
describe("the edges of first-seen", () => {
  const PROVENANCE_TRUSTED_FROM = "2026-08-20T07:13:00.000Z";
  const readings = [
    reading("2026-08-25T05:00:00.000Z", 100_00, "2026-08-25T06:00:00.000Z"),
    reading("2026-08-27T05:00:00.000Z", 90_00, "2026-08-27T06:00:00.000Z"),
  ];

  // Fetched BEFORE the provenance instant, so that `firstSeenAt > fetchedAt`
  // is satisfied either way and the only thing under test is the provenance
  // comparison itself.
  const fetchedBeforeProvenance = [
    reading("2026-08-19T05:00:00.000Z", 100_00, "2026-08-19T06:00:00.000Z"),
    reading("2026-08-21T05:00:00.000Z", 90_00, "2026-08-21T06:00:00.000Z"),
  ];

  it("counts a transaction first seen at the very instant provenance became trustworthy", () => {
    // `>=`, not `>`. The first write after that instant is write-once and
    // therefore true; excluding it would discard the earliest row the rule can
    // legitimately use.
    const result = reconcileAccount(
      "acc-1",
      fetchedBeforeProvenance,
      [settledLate("2026-08-18T00:00:00Z", -10_00, PROVENANCE_TRUSTED_FROM)],
    );
    expect(result.breaks).toHaveLength(0);
  });

  it("ignores a transaction first seen one millisecond before it", () => {
    // Below the instant the value records the LAST write, not the first, and
    // the rolling ten-day refetch makes most recent rows look newly settled.
    // Trusting those is exactly what took one break to six.
    const result = reconcileAccount(
      "acc-1",
      fetchedBeforeProvenance,
      [settledLate("2026-08-18T00:00:00Z", -10_00, "2026-08-20T07:12:59.999Z")],
    );
    expect(result.breaks).toHaveLength(1);
  });

  it("ignores a transaction first seen at the exact moment the older reading was fetched", () => {
    // `>`, not `>=`. Held at the instant the balance was taken means it was in
    // that balance, so counting it again would double it.
    const result = reconcileAccount(
      "acc-1",
      readings,
      [settledLate("2026-08-24T00:00:00Z", -10_00, "2026-08-25T06:00:00.000Z")],
    );
    expect(result.breaks).toHaveLength(1);
  });

  it("does not treat a transaction inside the window as a late settler as well", () => {
    // Dated after the older reading, so the window already has it. Counting it
    // twice would turn a reconciled account into a break for the full amount.
    const result = reconcileAccount(
      "acc-1",
      readings,
      [settledLate("2026-08-26T00:00:00Z", -10_00, "2026-08-27T05:30:00.000Z")],
    );
    expect(result.breaks).toHaveLength(0);
  });

  it("reads a legacy row with no first-seen as one we already had", () => {
    // Absent must mean "already held", not "just arrived" — otherwise every row
    // written before provenance was kept becomes a late settler.
    const result = reconcileAccount("acc-1", readings, [movement("2026-08-24T00:00:00Z", -10_00)]);
    expect(result.breaks).toHaveLength(1);
  });
});

describe("when there is nothing to check", () => {
  it("checks nothing for an account with no readings at all", () => {
    // A connected account that has never synced. Not a failure, and it must not
    // report as checked.
    expect(reconcileAccount("acc-1", [], [])).toEqual({ checked: 0, breaks: [] });
  });

  it("checks nothing for an account with exactly one reading", () => {
    // The normal state of every account until a second sync has run.
    const result = reconcileAccount("acc-1", [reading("2026-08-25T05:00:00.000Z", 100_00)], []);
    expect(result).toEqual({ checked: 0, breaks: [] });
  });
});
