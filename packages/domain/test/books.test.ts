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
  categoryLeg,
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
    expect(categoryLeg(trade)).toMatchObject({ book: "groceries", amount: 1299 });
  });

  it("does the same for money arriving, whose other side is the outside world", () => {
    const trade = tradeFor(
      recorded({ amount: 250_000, transactionType: "CREDIT", providerCategory: "CREDIT" }),
      assigned("n:1", "salary"),
    );

    expect(accountLeg(trade).amount).toBe(250_000);
    expect(categoryLeg(trade)).toMatchObject({ book: "salary", amount: -250_000 });
    expect(isBalanced(trade)).toBe(true);
  });

  it("applies both legs when the money moved, not when either was recorded", () => {
    const trade = tradeFor(
      recorded({ timestamp: "2026-03-15T00:00:00Z" }),
      assigned("n:1", "groceries", { appliedAt: "2026-08-01T00:00:00Z" }),
    );

    // Improving a rule corrects March, rather than posting a lump in August.
    expect(accountLeg(trade).appliesAt).toBe("2026-03-15T00:00:00Z");
    expect(categoryLeg(trade).appliesAt).toBe("2026-03-15T00:00:00Z");
  });

  it("records each leg when we decided it, which is not the same moment", () => {
    const trade = tradeFor(
      recorded({ ingestedAt: "2026-03-16T00:00:00Z" }),
      assigned("n:1", "groceries", { appliedAt: "2026-08-01T00:00:00Z" }),
    );

    expect(accountLeg(trade).recordedAt).toBe("2026-03-16T00:00:00Z");
    expect(categoryLeg(trade).recordedAt).toBe("2026-08-01T00:00:00Z");
  });

  it("records an unfiled transaction's second leg when we ingested it", () => {
    const trade = tradeFor(recorded({ ingestedAt: "2026-03-16T00:00:00Z" }), undefined);

    expect(categoryLeg(trade).recordedAt).toBe("2026-03-16T00:00:00Z");
  });
});

describe("isBalanced", () => {
  it("is false for a trade whose legs do not sum to zero", () => {
    // Not constructible through `tradeFor`; asserted so the invariant is a
    // checked claim rather than a comment.
    expect(
      isBalanced({
        dedupKey: "n:1",
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

    expect(trades.map((t) => categoryLeg(t).book)).toEqual(["groceries", "ATM"]);
    expect(trades.every(isBalanced)).toBe(true);
  });
});
