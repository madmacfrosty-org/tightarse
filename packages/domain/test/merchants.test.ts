import { describe, it, expect } from "vitest";
import {
  MERCHANTS,
  describableMerchants,
  merchantCategories,
  merchantPatternFor,
} from "../src/categorisation/merchants.js";
import { RULES } from "../src/categorisation/merchant-rules.js";

/**
 * One list, two derivations.
 *
 * The rules a household starts with and the descriptions generated data uses
 * come from the same entries. Before this they were two lists with no reason to
 * agree, and seeded data arrived entirely uncategorised as a result.
 */

describe("the merchant list", () => {
  it("matches every merchant with the rule generated for its category", () => {
    // The property that makes generated data categorisable by construction.
    for (const m of MERCHANTS) {
      const pattern = new RegExp(merchantPatternFor(m.category), "i");
      const rule = RULES.find((r) => r.pattern.source === pattern.source);
      expect(rule, `no rule covers ${m.category}`).toBeDefined();
      expect(rule!.category).toBe(m.category);
    }
  });

  it("matches the descriptions it tells a generator to write", () => {
    // A merchant whose own description its own rule cannot match would produce
    // data that looks right and categorises as nothing.
    for (const m of describableMerchants()) {
      const pattern = new RegExp(merchantPatternFor(m.category), "i");
      expect(
        pattern.test(m.description),
        `${m.category} rule missed its own description`,
      ).toBe(true);
    }
  });

  it("assigns each description exactly one category", () => {
    // Every seeded rule asserts, and two asserts on one transaction is a
    // conflict that yields NO category. A description matching two categories
    // would silently produce nothing rather than the wrong thing.
    for (const m of describableMerchants()) {
      const hits = merchantCategories().filter((c) =>
        new RegExp(merchantPatternFor(c), "i").test(m.description),
      );
      expect(
        hits,
        `${m.description} matched ${hits.join(" and ")}`,
      ).toHaveLength(1);
    }
  });

  it("keeps the wording rules a merchant list cannot express", () => {
    // Bank charges and card payoffs match on wording, not on a merchant.
    const derived = merchantCategories().map((c) => merchantPatternFor(c));
    const literal = RULES.filter((r) => !derived.includes(r.pattern.source));
    expect(literal.map((r) => r.category).sort()).toEqual([
      "Council Tax",
      "Fees & Charges",
      "Fees & Charges",
      "Transfer",
      "Transfer",
    ]);
  });

  it("refuses to build a pattern for a category with no merchants", () => {
    expect(() => merchantPatternFor("Nonexistent" as never)).toThrow(
      /no merchants/,
    );
  });

  it("carries spend ranges in whole minor units", () => {
    for (const m of describableMerchants()) {
      expect(Number.isInteger(m.spend[0])).toBe(true);
      expect(Number.isInteger(m.spend[1])).toBe(true);
      expect(m.spend[1]).toBeGreaterThan(m.spend[0]);
    }
  });
});
