/**
 * The books vocabulary.
 *
 * Step 1 of #108 names what the ledger already contained, so these tests are
 * about the naming being faithful rather than about any new behaviour: that a
 * trade isBalanced, that the second leg goes where categorising says, and that the
 * signs are the two ends of one movement.
 */

import { describe, it, expect } from "vitest";
import {
  accountLeg,
  isBalanced,
  bookFor,
  otherLeg,
  tradeFor,
  tradesFrom,
  UNCATEGORISED,
} from "../src/ledger/books.js";
import { recorded, assigned } from "./recorded.js";

describe("bookFor", () => {
  it("uses our category when a rule has filed it", () => {
    expect(bookFor(recorded(), assigned("n:1", "groceries"))).toBe("groceries");
  });

  it("falls back to the provider's own category, so nothing is uncategorised", () => {
    expect(bookFor(recorded({ providerCategory: "DIRECT_DEBIT" }), undefined)).toBe(
      "DIRECT_DEBIT",
    );
  });

  it("names the fallback only when the provider named nothing either", () => {
    expect(bookFor(recorded({ providerCategory: undefined }), undefined)).toBe(
      UNCATEGORISED,
    );
  });
});

describe("tradeFor", () => {
  it("isBalanced to zero, which is the invariant and not a variety", () => {
    const trade = tradeFor(recorded({ amount: -1299 }), undefined);
    expect(isBalanced(trade)).toBe(true);
  });

  it("keeps the transaction's sign on the account leg and negates the other", () => {
    // A payment out: cash falls, and the book it was spent on rises. An expense
    // book's position is positive, which is what the summary negates back.
    const trade = tradeFor(recorded({ amount: -1299 }), assigned("n:1", "groceries"));

    expect(accountLeg(trade)).toMatchObject({ book: "acc1", amount: -1299 });
    expect(otherLeg(trade)).toMatchObject({ book: "groceries", amount: 1299 });
  });

  it("does the same for money arriving, whose other side is the outside world", () => {
    const trade = tradeFor(
      recorded({ amount: 250_000, transactionType: "CREDIT", providerCategory: "CREDIT" }),
      assigned("n:1", "salary"),
    );

    expect(accountLeg(trade).amount).toBe(250_000);
    expect(otherLeg(trade)).toMatchObject({ book: "salary", amount: -250_000 });
    expect(isBalanced(trade)).toBe(true);
  });

  it("applies both legs when the money moved, not when either was recorded", () => {
    const trade = tradeFor(
      recorded({ timestamp: "2026-03-15T00:00:00Z" }),
      assigned("n:1", "groceries", { appliedAt: "2026-08-01T00:00:00Z" }),
    );

    // Improving a rule corrects March, rather than posting a lump in August.
    expect(accountLeg(trade).appliesAt).toBe("2026-03-15T00:00:00Z");
    expect(otherLeg(trade).appliesAt).toBe("2026-03-15T00:00:00Z");
  });

  it("records each leg when we decided it, which is not the same moment", () => {
    const trade = tradeFor(
      recorded({ ingestedAt: "2026-03-16T00:00:00Z" }),
      assigned("n:1", "groceries", { appliedAt: "2026-08-01T00:00:00Z" }),
    );

    expect(accountLeg(trade).recordedAt).toBe("2026-03-16T00:00:00Z");
    expect(otherLeg(trade).recordedAt).toBe("2026-08-01T00:00:00Z");
  });

  it("records an unfiled transaction's second leg when we ingested it", () => {
    const trade = tradeFor(recorded({ ingestedAt: "2026-03-16T00:00:00Z" }), undefined);

    expect(otherLeg(trade).recordedAt).toBe("2026-03-16T00:00:00Z");
  });
});

describe("isBalanced", () => {
  it("is false for a trade whose legs do not sum to zero", () => {
    // Not constructible through `tradeFor`; asserted so the invariant is a
    // checked claim rather than a comment.
    expect(
      isBalanced({
        dedupKeys: ["n:1"],
        legs: [
          { book: "acc1", amount: -1299, appliesAt: "x", recordedAt: "y" },
          { book: "groceries", amount: 1, appliesAt: "x", recordedAt: "y" },
        ],
      }),
    ).toBe(false);
  });
});

describe("tradesFrom", () => {
  it("gives one trade per transaction, filed by what categorised it", () => {
    const rows = [
      recorded({ dedupKey: "n:1", transactionId: "t1" }),
      recorded({ dedupKey: "n:2", transactionId: "t2", providerCategory: "ATM" }),
    ];
    const map = new Map([["n:1", assigned("n:1", "groceries")]]);

    const trades = tradesFrom(rows, map);

    expect(trades.map((t) => otherLeg(t).book)).toEqual(["groceries", "ATM"]);
    expect(trades.every(isBalanced)).toBe(true);
  });
});

/**
 * #74: a transfer is one movement of money the bank reports twice.
 *
 * The arithmetic these pin is the one that made #143 wrong by six figures, and
 * the shape is the same: a second leg filed where it does not belong, counted
 * again by whatever consumes it. Every figure and account name is invented.
 */
describe("a transfer is one trade, not two", () => {
  const out = recorded({
    dedupKey: "n:out",
    transactionId: "t-out",
    accountId: "current",
    amount: -500_00,
    transactionType: "DEBIT",
    timestamp: "2026-03-15T00:00:00Z",
  });
  const into = recorded({
    dedupKey: "n:in",
    transactionId: "t-in",
    accountId: "savings",
    amount: 500_00,
    transactionType: "CREDIT",
    timestamp: "2026-03-17T00:00:00Z",
  });
  const pair = {
    out: "n:out",
    in: "n:in",
    amount: 500_00,
    daysApart: 2,
    fromAccount: "current",
    toAccount: "savings",
  };

  it("collapses the pair into a single trade", () => {
    const trades = tradesFrom([out, into], new Map(), [pair]);

    expect(trades).toHaveLength(1);
    expect(trades[0]!.dedupKeys).toEqual(["n:out", "n:in"]);
    expect(trades.every(isBalanced)).toBe(true);
  });

  it("names both accounts and no category at all", () => {
    const [trade] = tradesFrom([out, into], new Map(), [pair]);

    expect(accountLeg(trade!).book).toBe("current");
    expect(otherLeg(trade!).book).toBe("savings");
  });

  it("moves each account once, which is what one trade per event buys", () => {
    // The regression this exists for: given a trade each, the pair contributes
    // to both accounts twice and every position doubles.
    const byBook = new Map<string, number>();
    for (const trade of tradesFrom([out, into], new Map(), [pair]))
      for (const leg of trade.legs)
        byBook.set(leg.book, (byBook.get(leg.book) ?? 0) + leg.amount);

    expect(byBook.get("current")).toBe(-500_00);
    expect(byBook.get("savings")).toBe(500_00);
    expect([...byBook.keys()].sort()).toEqual(["current", "savings"]);
  });

  it("keeps each leg on its own date, because the legs can be days apart", () => {
    // One date forced on both would move money out of an account before it
    // arrived in the other, or after.
    const [trade] = tradesFrom([out, into], new Map(), [pair]);

    expect(accountLeg(trade!).appliesAt).toBe("2026-03-15T00:00:00Z");
    expect(otherLeg(trade!).appliesAt).toBe("2026-03-17T00:00:00Z");
  });

  it("leaves a pair alone when only one leg is in view", () => {
    // Detection may be given a wider set than the one being summed. A pair it
    // found across that margin is not ours to collapse.
    const trades = tradesFrom([out], new Map(), [pair]);

    expect(trades).toHaveLength(1);
    expect(trades[0]!.dedupKeys).toEqual(["n:out"]);
    expect(otherLeg(trades[0]!).book).toBe("PURCHASE");
  });
});
