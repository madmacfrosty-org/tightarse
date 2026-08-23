import { describe, it, expect } from "vitest";
import {
  OVERRIDES,
  OVERRIDES_ORDER,
  overrideRule,
  overridesSet,
  reviewOverrides,
} from "../src/categorisation/overrides.js";
import { evaluate } from "../src/categorisation/evaluate.js";
import type { Rule, RuleSet } from "../src/categorisation/rules.js";
import type { Candidate } from "../src/categorisation/taxonomy.js";

/**
 * Corrections, as rules.
 *
 * The two reports are the point: an override the rules have caught up with is
 * manual state that can shrink, and one the rules contradict names a defect
 * that is wrong for every transaction like it, not just this one.
 */

const NOW = new Date("2026-03-01T09:00:00.000Z");

const tx = (dedupKey: string, description: string, amount = -10_00): Candidate => ({
  dedupKey,
  description,
  amount,
  currency: "GBP",
});

const asserts = (pattern: string, category: string): Rule => ({
  matcher: { kind: "merchant", pattern },
  contributes: { kind: "assert", category },
  appliesTo: "debits",
});

const set = (setId: string, order: number, rules: Rule[], authored = false): RuleSet => ({
  setId,
  version: 1,
  name: setId,
  order,
  authored,
  status: "effective",
  rules,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const withOverrides = (rules: Rule[]) => set(OVERRIDES, OVERRIDES_ORDER, rules, true);

describe("an override as a rule", () => {
  it("outranks a hand-written merchant rule", () => {
    // It is about ONE transaction, and whoever wrote it was looking at that
    // transaction. Nothing has better information.
    const sets = [
      set("household", 0, [asserts("somemart", "groceries")], true),
      withOverrides([overrideRule("d1", "fuel")]),
    ];
    expect(evaluate(sets, tx("d1", "SOMEMART FORECOURT")).effective).toMatchObject({
      setId: OVERRIDES,
      category: "fuel",
    });
  });

  it("applies to a credit as well as a debit", () => {
    // The debit default exists to stop a merchant pattern catching a salary,
    // which cannot happen for a rule naming one transaction.
    const sets = [withOverrides([overrideRule("d1", "income")])];
    expect(evaluate(sets, tx("d1", "A PAYMENT", 2_500_00)).effective?.category).toBe("income");
  });

  it("touches nothing but the transaction it names", () => {
    const sets = [withOverrides([overrideRule("d1", "fuel")])];
    expect(evaluate(sets, tx("d2", "SOMEMART FORECOURT")).effective).toBeUndefined();
  });

  it("starts a first set that is authored and outranks everything", () => {
    const first = overridesSet([], NOW);
    expect(first).toMatchObject({ setId: OVERRIDES, authored: true, version: 0, rules: [] });
    expect(first.order).toBeLessThan(0);
  });

  it("returns the existing set rather than a fresh one", () => {
    const existing = withOverrides([overrideRule("d1", "fuel")]);
    expect(overridesSet([existing], NOW)).toBe(existing);
  });

  it("carries a note, which is the only record of why a correction exists", () => {
    expect(overrideRule("d1", "fuel", "forecourt, not the shop").note).toBe("forecourt, not the shop");
  });
});

describe("reviewing overrides", () => {
  const builtIn = set("built-in", 2, [asserts("somemart", "groceries"), asserts("forecourt", "fuel")]);

  it("reports one the rules have caught up with", () => {
    // Manual state that can shrink instead of accumulating. A correction list
    // nobody prunes becomes a second rule set with none of the machinery.
    const sets = [withOverrides([overrideRule("d1", "fuel")]), builtIn];
    const review = reviewOverrides(sets, [tx("d1", "A FORECOURT")]);
    expect(review.redundant).toEqual([{ dedupKey: "d1", category: "fuel", agreedBy: "built-in" }]);
    expect(review.contradicted).toEqual([]);
  });

  it("reports one the rules contradict, and names the set that got it wrong", () => {
    // More valuable than the correction: one override fixes one transaction,
    // and the rule behind it is wrong for every transaction like it.
    const sets = [withOverrides([overrideRule("d1", "fuel")]), builtIn];
    const review = reviewOverrides(sets, [tx("d1", "SOMEMART SUPERSTORE")]);
    expect(review.contradicted).toEqual([
      { dedupKey: "d1", corrected: "fuel", rulesSay: "groceries", saidBy: "built-in" },
    ]);
    expect(review.redundant).toEqual([]);
  });

  it("says nothing about one the rules have no opinion on", () => {
    // Still doing work, so neither redundant nor a defect.
    const sets = [withOverrides([overrideRule("d1", "gifts-charity")]), builtIn];
    const review = reviewOverrides(sets, [tx("d1", "ZZQX UNKNOWN")]);
    expect(review).toMatchObject({ redundant: [], contradicted: [], total: 1 });
  });

  it("reports an override whose transaction is not in the corpus", () => {
    // Either a stale entry to remove, or a range too narrow to judge it.
    const sets = [withOverrides([overrideRule("gone", "fuel")]), builtIn];
    expect(reviewOverrides(sets, [tx("d1", "SOMEMART")]).orphaned).toEqual(["gone"]);
  });

  it("judges the rules without the override, not with it", () => {
    // Comparing against the answer the override itself produced would make
    // every override look redundant.
    const sets = [withOverrides([overrideRule("d1", "fuel")]), builtIn];
    const review = reviewOverrides(sets, [tx("d1", "SOMEMART SUPERSTORE")]);
    expect(review.contradicted).toHaveLength(1);
  });

  it("says nothing when there are no overrides at all", () => {
    expect(reviewOverrides([builtIn], [tx("d1", "SOMEMART")])).toEqual({
      total: 0,
      redundant: [],
      contradicted: [],
      orphaned: [],
    });
  });

  it("ignores a rule in the overrides set that names no transaction", () => {
    // Only a transaction matcher is an override. Anything else in there is
    // somebody using the set for something it is not for.
    const odd = set(OVERRIDES, OVERRIDES_ORDER, [asserts("somemart", "shopping")], true);
    const review = reviewOverrides([odd, builtIn], [tx("d1", "SOMEMART")]);
    expect(review).toMatchObject({ total: 1, redundant: [], contradicted: [] });
  });
});
