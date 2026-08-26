import { describe, it, expect } from "vitest";
import { evaluate, foldSet, literalMatcher, matches, matchesMatcher } from "../src/categorisation/evaluate.js";
import { Matcher } from "../src/categorisation/rules.js";
import type { Rule, RuleSet } from "../src/categorisation/rules.js";
import type { Candidate } from "../src/categorisation/taxonomy.js";

/**
 * Applying rule sets.
 *
 * The case this exists for is the supermarket forecourt: a broad merchant rule
 * and a narrow qualifier, where first-match-wins filed 26 fuel purchases as food
 * shopping. Under a fold they compose, and the composition is silent while a
 * genuine disagreement is not.
 *
 * Merchants here are invented. Real ones are household data and do not go in
 * files.
 */

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  dedupKey: "d1",
  description: "SOMEMART FORECOURT 118",
  amount: -40_00,
  currency: "GBP",
  ...over,
});

const rule = (matcher: Rule["matcher"], contributes: Rule["contributes"], over: Partial<Rule> = {}): Rule => ({
  matcher,
  contributes,
  appliesTo: "debits",
  ...over,
});

const set = (over: Partial<RuleSet> & { setId: string; order: number; rules: Rule[] }): RuleSet => ({
  version: 1,
  name: over.setId,
  authored: false,
  status: "effective" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const merchant = (pattern: string) => ({ kind: "merchant" as const, pattern });
const asserts = (category: string) => ({ kind: "assert" as const, category });
const refines = (category: string) => ({ kind: "refine" as const, category });

describe("whether a rule applies at all", () => {
  it("matches a merchant pattern case-insensitively", () => {
    // Descriptions arrive in whatever case the provider felt like, and the same
    // merchant is not two merchants.
    expect(matches(rule(merchant("somemart"), asserts("groceries")), candidate())).toBe(true);
  });

  it("excludes credits by default", () => {
    // An employer sharing a name with a retailer filed £62,868 of salary as
    // Shopping. `debits` is the default for exactly this.
    const r = rule(merchant("somemart"), asserts("groceries"));
    expect(matches(r, candidate({ amount: 2_500_00 }))).toBe(false);
  });

  it("matches only credits when the rule says so", () => {
    // Direction deciding the category outright: interest is Income when
    // received and Fees & Charges when paid, which is two rules over one
    // matcher and cannot be said without this.
    const r = rule(merchant("interest"), asserts("income"), { appliesTo: "credits" });
    expect(matches(r, candidate({ description: "INTEREST PAID", amount: 4_00 }))).toBe(true);
    expect(matches(r, candidate({ description: "INTEREST PAID", amount: -4_00 }))).toBe(false);
  });

  it("admits credits when the rule asks for them", () => {
    const r = rule(merchant("somemart"), asserts("income"), { appliesTo: "all" });
    expect(matches(r, candidate({ amount: 2_500_00 }))).toBe(true);
  });

  it("treats a zero amount as a credit, since it is certainly not a debit", () => {
    expect(matches(rule(merchant("somemart"), asserts("groceries")), candidate({ amount: 0 }))).toBe(false);
  });

  it("matches a provider category exactly, not loosely", () => {
    const r = rule({ kind: "providerCategory", value: "ATM" }, asserts("cash-withdrawal"));
    expect(matches(r, candidate({ providerCategory: "ATM" }))).toBe(true);
    expect(matches(r, candidate({ providerCategory: "ATM_WITHDRAWAL" }))).toBe(false);
    expect(matches(r, candidate({}))).toBe(false);
  });

  it("matches one specific transaction, which is what an override is", () => {
    const r = rule({ kind: "transaction", dedupKey: "d1" }, asserts("gifts-charity"));
    expect(matches(r, candidate())).toBe(true);
    expect(matches(r, candidate({ dedupKey: "d2" }))).toBe(false);
  });
});

describe("folding one set", () => {
  it("composes a broad assert with a narrow refine — the forecourt case", () => {
    // The defect this design exists for. Not two rules disagreeing: a merchant
    // and a qualifier, where the qualifier redirects what the merchant
    // established.
    const s = set({
      setId: "built-in",
      order: 2,
      rules: [rule(merchant("somemart"), asserts("groceries")), rule(merchant("forecourt"), refines("fuel"))],
    });
    const out = foldSet(s, candidate());
    expect(out.category).toBe("fuel");
    expect(out.problems).toEqual([]);
  });

  it("leaves a plain supermarket purchase alone", () => {
    const s = set({
      setId: "built-in",
      order: 2,
      rules: [rule(merchant("somemart"), asserts("groceries")), rule(merchant("forecourt"), refines("fuel"))],
    });
    expect(foldSet(s, candidate({ description: "SOMEMART SUPERSTORE 42" })).category).toBe("groceries");
  });

  it("applies rules in the set's own order, not the order they happen to match", () => {
    // Order within a set is data, which is what makes the fold deterministic.
    const rules = [rule(merchant("."), asserts("groceries")), rule(merchant("."), refines("fuel"))];
    expect(foldSet(set({ setId: "s", order: 1, rules }), candidate()).category).toBe("fuel");
    expect(foldSet(set({ setId: "s", order: 1, rules: [...rules].reverse() }), candidate()).category).toBe("groceries");
  });

  it("reports a refine that had nothing to refine, and applies nothing", () => {
    // A qualifier matching with no merchant established names a missing assert.
    // Letting it act as an assert would put Fuel on a transaction nobody
    // identified as a fuel purchase.
    const s = set({ setId: "built-in", order: 2, rules: [rule(merchant("forecourt"), refines("fuel"))] });
    // toStrictEqual, so the absent key stays absent: a set that concluded
    // nothing must not report a category of undefined, which reads as an answer
    // to anything checking whether the key is there.
    expect(foldSet(s, candidate())).toStrictEqual({
      setId: "built-in",
      version: 1,
      order: 2,
      problems: [{ kind: "inertRefine", category: "fuel" }],
    });
  });

  it("produces nothing when two rules assert, and says what collided", () => {
    // The set is claiming two answers with equal authority, so it claims
    // nothing usable. This is the signal first-match-wins could not give.
    const s = set({
      setId: "household",
      order: 0,
      rules: [rule(merchant("somemart"), asserts("groceries")), rule(merchant("forecourt"), asserts("fuel"))],
    });
    const out = foldSet(s, candidate());
    expect(out.category).toBeUndefined();
    expect(out.problems).toEqual([{ kind: "conflict", categories: ["groceries", "fuel"] }]);
  });

  it("does not call one assert and one refine a conflict", () => {
    const s = set({
      setId: "built-in",
      order: 2,
      rules: [rule(merchant("somemart"), asserts("groceries")), rule(merchant("forecourt"), refines("fuel"))],
    });
    expect(foldSet(s, candidate()).problems).toEqual([]);
  });
});

describe("across sets", () => {
  const household = set({
    setId: "household",
    order: 0,
    authored: true,
    rules: [rule(merchant("nowhere-at-all"), asserts("shopping"))],
  });
  const builtIn = set({ setId: "built-in", order: 2, rules: [rule(merchant("somemart"), asserts("groceries"))] });

  it("takes the answer from the lowest order that produced one", () => {
    const withHousehold = set({ ...household, rules: [rule(merchant("somemart"), asserts("shopping"))] });
    const out = evaluate([builtIn, withHousehold], candidate());
    expect(out.effective).toEqual({ setId: "household", version: 1, category: "shopping" });
  });

  it("falls through to a lower-precedence set when the higher one says nothing", () => {
    const out = evaluate([household, builtIn], candidate());
    expect(out.effective?.setId).toBe("built-in");
  });

  it("falls through past a set that conflicted with itself", () => {
    // A defect in the household rules should not leave a transaction
    // uncategorised when built-in has a perfectly good answer. The conflict is
    // still reported.
    const conflicted = set({
      ...household,
      rules: [rule(merchant("somemart"), asserts("shopping")), rule(merchant("forecourt"), asserts("fuel"))],
    });
    const out = evaluate([conflicted, builtIn], candidate());
    expect(out.effective?.setId).toBe("built-in");
    expect(out.sets[0]?.problems[0]?.kind).toBe("conflict");
  });

  it("evaluates every set, so what each one said is answerable", () => {
    // Not just the winner: "what did each source say" is the audit question,
    // and it is unavailable under first-match-wins.
    const out = evaluate([household, builtIn], candidate());
    expect(out.sets.map((s) => s.setId)).toEqual(["household", "built-in"]);
  });

  it("evaluates in order regardless of the order it was handed", () => {
    // A caller must not be able to change the answer by passing sets in the
    // order a scan happened to return them.
    const a = evaluate([builtIn, household], candidate());
    const b = evaluate([household, builtIn], candidate());
    expect(a).toEqual(b);
  });

  it("breaks a tie in order by set id, rather than by whatever order they arrived", () => {
    // Two sets sharing an order is a data mistake, but it must not make the
    // answer depend on how a scan happened to return them: the same ledger
    // would categorise differently on two runs and the history would churn.
    const a = set({ setId: "aaa", order: 5, rules: [rule(merchant("somemart"), asserts("shopping"))] });
    const b = set({ setId: "bbb", order: 5, rules: [rule(merchant("somemart"), asserts("groceries"))] });
    expect(evaluate([a, b], candidate()).effective?.setId).toBe("aaa");
    expect(evaluate([b, a], candidate()).effective?.setId).toBe("aaa");
  });

  it("says nothing when no set matches, which is the backlog rather than a failure", () => {
    const out = evaluate([household], candidate({ description: "UTTERLY UNKNOWN" }));
    expect(out.effective).toBeUndefined();
    expect(out.sets).toHaveLength(1);
  });

  it("gives the same answer twice, because idempotency is load-bearing", () => {
    // Applying the same set version to the same transaction must give the same
    // answer, or every run appends a version and the history fills with churn.
    const c = candidate();
    expect(evaluate([household, builtIn], c)).toEqual(evaluate([household, builtIn], c));
  });
});

describe("building a matcher from a word somebody typed", () => {
  const seen = (description: string, amount = -10_00): Candidate => ({
    dedupKey: "d1",
    description,
    amount,
    currency: "GBP",
  });

  it.each([
    ["SHELL", "SHELL GARAGE", true],
    ["shell", "SHELL GARAGE", true],
    ["SHELL", "TOTALLY UNRELATED", false],
  ])("matches %s against %s", (term, description, expected) => {
    expect(matchesMatcher(literalMatcher(term), seen(description))).toBe(expected);
  });

  it.each([
    ["PIZZA (EXPRESS)", "PIZZA (EXPRESS) 42", true],
    ["PIZZA (EXPRESS)", "PIZZA EXPRESS 42", false],
    ["a+b", "A+B LTD", true],
    ["a+b", "AAAB LTD", false],
  ])("takes %s literally, so punctuation is not a pattern", (term, description, expected) => {
    // Unescaped these are groups, quantifiers and character classes. A shop
    // with a bracket in its name is not a regular expression, and the person
    // typing it has no reason to think it might be.
    expect(matchesMatcher(literalMatcher(term), seen(description))).toBe(expected);
  });

  it("survives a term that would be a syntax error unescaped", () => {
    expect(() => matchesMatcher(literalMatcher("a+["), seen("ANYTHING"))).not.toThrow();
  });

  it("says nothing about direction, which is the rule's business", () => {
    // `matches` gates on direction; this is the half underneath it, so a search
    // finds a refund and a debits-only rule still declines to categorise it.
    expect(matchesMatcher(literalMatcher("REFUND"), seen("REFUND SOMEMART", 25_00))).toBe(true);
  });

  it("is the same matcher a rule uses, which is the point of sharing it", () => {
    const rule = {
      matcher: literalMatcher("SOMEMART"),
      contributes: { kind: "assert" as const, category: "groceries" },
      appliesTo: "all" as const,
    };

    expect(matches(rule, seen("SOMEMART 118"))).toBe(matchesMatcher(literalMatcher("SOMEMART"), seen("SOMEMART 118")));
  });
});

describe("matching on an amount", () => {
  const seen = (amount: number): Candidate => ({
    dedupKey: "d1",
    description: "SOMEMART 118",
    amount,
    currency: "GBP",
  });

  it.each([
    [-95_00, true],
    [-90_00, true],
    [-100_00, true],
    [-89_99, false],
    [-100_01, false],
  ])("takes %i against a range of £90 to £100: %s", (amount, expected) => {
    expect(matchesMatcher({ kind: "amount", min: 90_00, max: 100_00 }, seen(amount))).toBe(expected);
  });

  it("reads the size, not the sign, because direction lives in appliesTo", () => {
    // Debits are negative. A bound expressed as a negative range would make
    // every rule say direction twice, and disagree with itself eventually.
    const range = { kind: "amount" as const, min: 90_00, max: 100_00 };

    expect(matchesMatcher(range, seen(-95_00))).toBe(true);
    expect(matchesMatcher(range, seen(95_00))).toBe(true);
  });

  it("is open at the end that was left out", () => {
    expect(matchesMatcher({ kind: "amount", min: 90_00 }, seen(-1_000_00))).toBe(true);
    expect(matchesMatcher({ kind: "amount", max: 100_00 }, seen(-1_00))).toBe(true);
  });

  it("refuses a range open at both ends, which is not a condition", () => {
    expect(() => Matcher.parse({ kind: "amount" })).toThrow();
  });
});

describe("matching on several conditions at once", () => {
  const seen = (over: Partial<Candidate> = {}): Candidate => ({
    dedupKey: "d1",
    description: "SOMEMART 118",
    amount: -95_00,
    currency: "GBP",
    providerCategory: "DIRECT_DEBIT",
    ...over,
  });

  const all = {
    kind: "all" as const,
    of: [
      { kind: "providerCategory" as const, value: "DIRECT_DEBIT" },
      { kind: "merchant" as const, pattern: "somemart" },
      { kind: "amount" as const, min: 90_00, max: 100_00 },
    ],
  };

  it("holds only when every condition does", () => {
    expect(matchesMatcher(all, seen())).toBe(true);
  });

  it.each([
    ["the type", { providerCategory: "PURCHASE" }],
    ["the description", { description: "OTHERSHOP" }],
    ["the amount", { amount: -5_00 }],
  ])("fails when %s does not match", (_which, over) => {
    // The point of the conjunction: any one of them is enough to decline. A
    // rule for a direct debit from one merchant in a band is all three or none.
    expect(matchesMatcher(all, seen(over))).toBe(false);
  });

  it("refuses a conjunction of one, because that condition is the matcher", () => {
    expect(() =>
      Matcher.parse({ kind: "all", of: [{ kind: "merchant", pattern: "somemart" }] }),
    ).toThrow();
  });

  it("refuses a conjunction of none", () => {
    expect(() => Matcher.parse({ kind: "all", of: [] })).toThrow();
  });

  it("does not nest, because nothing that builds one needs a tree", () => {
    expect(() =>
      Matcher.parse({
        kind: "all",
        of: [
          { kind: "merchant", pattern: "a" },
          { kind: "all", of: [{ kind: "merchant", pattern: "b" }, { kind: "merchant", pattern: "c" }] },
        ],
      }),
    ).toThrow();
  });

  it("is still gated by direction, like any other rule", () => {
    const rule = { matcher: all, contributes: { kind: "assert" as const, category: "bills" }, appliesTo: "debits" as const };

    expect(matches(rule, seen())).toBe(true);
    expect(matches(rule, seen({ amount: 95_00 }))).toBe(false);
  });
});
