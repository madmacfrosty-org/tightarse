/**
 * #108 step 3: every book has a position, and the ones that roll up are what
 * the household is worth.
 *
 * The claim being tested is that one arithmetic serves a bank account, a
 * category and a loan. The case that proves it is the mortgage: a repayment
 * leaves the current account and arrives in the loan book, so the household's
 * position does not move — which is correct, and which the old computation
 * could not express because a loan was not a thing it knew about.
 *
 * Every figure and label is invented.
 */

import { describe, it, expect } from "vitest";
import {
  householdPosition,
  isBalanceSheet,
  type BookPosition,
} from "../src/ledger/books.js";

const book = (over: Partial<BookPosition> = {}): BookPosition => ({
  book: "b",
  label: "B",
  nature: "asset",
  rollsUp: true,
  position: 0,
  ...over,
});

describe("what the household is worth", () => {
  it("adds every book that rolls up, without a rule for any of them", () => {
    // The version this replaces subtracted cards by name. Here cash, a card and
    // a mortgage are all just numbers, because they are all in one convention.
    expect(
      householdPosition([
        book({ book: "current", position: 2_000_00 }),
        book({ book: "card", nature: "liability", position: -421_50 }),
        book({ book: "mortgage", nature: "liability", position: -180_000_00 }),
      ]),
    ).toBe(2_000_00 - 421_50 - 180_000_00);
  });

  it("leaves out what a household has spent, because that is not what it is worth", () => {
    expect(
      householdPosition([
        book({ book: "current", position: 2_000_00 }),
        book({ book: "groceries", nature: "expense", rollsUp: false, position: 12_450_00 }),
        book({ book: "salary", nature: "income", rollsUp: false, position: -90_000_00 }),
      ]),
    ).toBe(2_000_00);
  });

  it("is nothing when there are no books at all", () => {
    expect(householdPosition([])).toBe(0);
  });

  it("does not move when a loan is repaid", () => {
    // The whole point of giving a liability a book. £500 leaves the current
    // account and the mortgage owes £500 less. Nothing was spent and nothing
    // was earned, and the household is worth exactly what it was.
    const before = householdPosition([
      book({ book: "current", position: 3_000_00 }),
      book({ book: "mortgage", nature: "liability", position: -180_000_00 }),
    ]);
    const after = householdPosition([
      book({ book: "current", position: 2_500_00 }),
      book({ book: "mortgage", nature: "liability", position: -179_500_00 }),
    ]);
    expect(after).toBe(before);
  });

  it("rises when money is earned and falls when it is spent", () => {
    const spent = householdPosition([book({ book: "current", position: 2_500_00 })]);
    const earned = householdPosition([book({ book: "current", position: 3_500_00 })]);
    expect(earned - spent).toBe(1_000_00);
  });
});

describe("which books count", () => {
  it.each([
    ["asset", true],
    ["liability", true],
    ["income", false],
    ["expense", false],
  ] as const)("%s rolls up: %s", (nature, expected) => {
    expect(isBalanceSheet(nature)).toBe(expected);
  });
});
