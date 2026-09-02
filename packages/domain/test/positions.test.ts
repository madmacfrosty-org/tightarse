/**
 * #108 step 2: a book's position is the running sum of its legs.
 *
 * The claim worth testing is not that the arithmetic adds up — it is that
 * *deriving* an account's position reproduces the figure the provider stated,
 * on a ledger where nothing is missing and nothing is misdated. That is what
 * makes the switch from observing to deriving safe to make: where the two
 * disagree, the ledger and the bank disagree, and that is the disagreement the
 * step is meant to surface rather than a fault in the sum.
 *
 * The ledger here is generated from a fixed seed and entirely invented.
 */

import { describe, it, expect } from "vitest";
import { sampleLedger, ACCOUNTS } from "./ledger-sample.js";
import {
  accountSeries,
  openingPosition,
  derivedPosition,
  daysBetween,
  inLedgerOrder,
  type Movement,
} from "../src/reporting/balances.js";
import { positionsFor, type Leg } from "../src/ledger/books.js";

const DAYS = daysBetween("2026-01-01", "2026-04-01");

/** An account book's legs are its own side of each transaction. */
const legsOf = (movements: readonly Movement[]): Leg[] =>
  inLedgerOrder(movements).map((m) => ({
    book: m.accountId,
    amount: m.amount,
    appliesAt: m.timestamp,
    recordedAt: m.timestamp,
  }));

describe("a position derived from legs", () => {
  const sample = sampleLedger();
  const forAccount = (id: string) =>
    sample.movements.filter((m) => m.accountId === id);

  it.each(ACCOUNTS.map((a) => a.accountId))(
    "reproduces the observed series exactly for %s",
    (accountId) => {
      const account = ACCOUNTS.find((a) => a.accountId === accountId)!;
      const movements = forAccount(accountId);
      const observed = accountSeries(account, movements, DAYS);
      const opening = openingPosition(account, movements);
      const derived = positionsFor(legsOf(movements), DAYS, opening);

      // A card is reported as what is OWED, carried positive, while its legs
      // are negative when money left. So the derived position is the negation
      // of the reported one — the same figure in the other convention, not a
      // different figure. That asymmetry is the whole of what #108 step 3 turns
      // into `nature`, and pinning it here means the step cannot quietly flip a
      // sign on the way through.
      const sign = account.isCard === true ? -1 : 1;

      // Days before the account's first transaction have no observed figure.
      const compared = observed
        .map((o, i) => (o === undefined ? null : [o, sign * derived[i]!]))
        .filter((p): p is [number, number] => p !== null);
      expect(compared.length).toBeGreaterThan(50);
      expect(compared.filter(([o, d]) => o !== d)).toEqual([]);
    },
  );

  it("recovers an opening position the ledger was never told", () => {
    // 1_250_000 is what `ledger-sample` opened the current account at. Nothing
    // stores it: it is recovered from the first running balance less the
    // transactions up to it, which only works because that balance is a
    // closing position.
    expect(openingPosition(ACCOUNTS[0]!, forAccount("acc-current"))).toBe(
      1_250_000,
    );
    expect(openingPosition(ACCOUNTS[1]!, forAccount("acc-savings"))).toBe(
      3_400_000,
    );
  });

  it("walks a card back from what is owed, having no running balance to start from", () => {
    // Ends where the provider says it is: the position after every leg is what
    // is owed now, negated into leg convention.
    const card = ACCOUNTS[2]!;
    const movements = forAccount("acc-card");
    const opening = openingPosition(card, movements)!;
    const total = movements.reduce((s, m) => s + m.amount, 0);
    expect(opening + total).toBe(-card.currentBalance!);
  });

  it("has no opening to offer for an account with nothing in it", () => {
    expect(openingPosition(ACCOUNTS[0]!, [])).toBeUndefined();
    expect(openingPosition(ACCOUNTS[2]!, [])).toBeUndefined();
  });

  it("cannot open a current account whose rows carry no running balance", () => {
    // Every row pending, which is the state of a newly connected account.
    expect(
      openingPosition(ACCOUNTS[0]!, [
        {
          accountId: "acc-current",
          timestamp: "2026-01-05T00:00:00Z",
          amount: -1_00,
          dedupKey: "a",
        },
      ]),
    ).toBeUndefined();
  });

  it("cannot open a card whose balance was never read", () => {
    expect(
      openingPosition({ accountId: "c", isCard: true }, [
        {
          accountId: "c",
          timestamp: "2026-01-05T00:00:00Z",
          amount: -1_00,
          dedupKey: "a",
        },
      ]),
    ).toBeUndefined();
  });
});

describe("the position an account reports now", () => {
  const m = (
    amount: number,
    runningBalance?: number,
    status?: string,
  ): Movement => ({
    accountId: "a",
    timestamp: "2026-03-01T00:00:00Z",
    amount,
    dedupKey: `d${amount}${status ?? ""}`,
    ...(runningBalance === undefined ? {} : { runningBalance }),
    ...(status === undefined ? {} : { status }),
  });

  it("says what the legs add up to, not what the provider last stated", () => {
    // The bank says 900; one transaction of 500 is all the ledger holds. The
    // position is 500, and the 400 gap is the disagreement step 2 exists to
    // put on screen rather than paper over.
    expect(
      derivedPosition(
        { accountId: "a", isCard: false, currentBalance: 900_00 },
        [m(500_00, 500_00)],
      ),
    ).toBe(500_00);
  });

  it("gives a card back the provider's own figure, having nothing else to go on", () => {
    // A card carries no running balance, so its opening is what is owed walked
    // back and walking forward returns it. This is not a coincidence to be
    // tested around: it means the change cannot move a card's tile.
    expect(
      derivedPosition(
        { accountId: "a", isCard: true, currentBalance: 100_00 },
        [m(-100_00), m(-25_00)],
      ),
    ).toBe(100_00);
  });

  it("leaves a pending row out, because it is not in the provider's chain either", () => {
    expect(
      derivedPosition({ accountId: "a", isCard: false }, [
        m(500_00, 500_00),
        m(-10_00, undefined, "pending"),
      ]),
    ).toBe(500_00);
  });

  it("has nothing to say about an account it cannot open", () => {
    expect(derivedPosition({ accountId: "a", isCard: false }, [])).toBeUndefined();
  });
});

describe("positions for a book that is not an account", () => {
  it("starts at zero, because a category book began empty", () => {
    const legs: Leg[] = [
      { book: "groceries", amount: -10_00, appliesAt: "2026-01-02T00:00:00Z", recordedAt: "x" },
      { book: "groceries", amount: -15_00, appliesAt: "2026-01-04T00:00:00Z", recordedAt: "x" },
    ];
    expect(positionsFor(legs, daysBetween("2026-01-01", "2026-01-05"))).toEqual([
      0, -10_00, -10_00, -25_00, -25_00,
    ]);
  });

  it("carries in everything effective before the window opens", () => {
    // A window that starts after the book did must open at the position the
    // book had reached, not at its opening figure. Otherwise every chart that
    // does not start at the beginning of time begins with a jump.
    const legs: Leg[] = [
      { book: "groceries", amount: -10_00, appliesAt: "2025-12-30T00:00:00Z", recordedAt: "x" },
      { book: "groceries", amount: -5_00, appliesAt: "2026-01-02T00:00:00Z", recordedAt: "x" },
    ];
    expect(positionsFor(legs, daysBetween("2026-01-01", "2026-01-03"))).toEqual([
      -10_00, -15_00, -15_00,
    ]);
  });

  it("places a leg by when it applied, not when it was recorded", () => {
    // The whole point of two axes: recategorising in March must move January's
    // figure rather than posting a lump in March.
    const legs: Leg[] = [
      { book: "groceries", amount: -10_00, appliesAt: "2026-01-02T00:00:00Z", recordedAt: "2026-03-01T00:00:00Z" },
    ];
    expect(positionsFor(legs, daysBetween("2026-01-01", "2026-01-03"))).toEqual([
      0, -10_00, -10_00,
    ]);
  });

  it("holds its position across days with no legs at all", () => {
    expect(
      positionsFor([], daysBetween("2026-01-01", "2026-01-03"), 42_00),
    ).toEqual([42_00, 42_00, 42_00]);
  });

  it("has nothing to say about an empty window", () => {
    expect(positionsFor([], [], 42_00)).toEqual([]);
  });
});
