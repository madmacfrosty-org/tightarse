import { enrichmentMetrics } from "./batch.js";
import { describe, it, expect } from "vitest";
import { applyRules, RULES } from "./rules.js";
import { isCategory } from "./taxonomy.js";
import type { Candidate } from "./categorise.js";

const cand = (description: string, over: Partial<Candidate> = {}): Candidate => ({
  dedupKey: `n:${description}`,
  description,
  amount: -1299,
  currency: "GBP",
  ...over,
});

describe("applyRules", () => {
  it("matches common merchants regardless of the surrounding noise", () => {
    const r = applyRules([
      cand("TESCO STORES 3456 LONDON"),
      cand("SHELL 12345 M4 SERVICES"),
      cand("NETFLIX.COM 4567"),
    ]);
    expect(r.classifications.map((c) => c.category)).toEqual([
      "Groceries",
      "Fuel",
      "Subscriptions",
    ]);
    expect(r.unmatched).toHaveLength(0);
  });

  it("uses the provider type for cash, where the description is a place not a merchant", () => {
    const r = applyRules([cand("HIGH STREET BRANCH", { providerCategory: "ATM" })]);
    expect(r.classifications[0]!.category).toBe("Cash Withdrawal");
  });

  it("leaves anything it does not recognise for the model", () => {
    const r = applyRules([cand("SOME LOCAL SHOP LTD"), cand("TESCO STORES 1")]);
    expect(r.unmatched).toHaveLength(1);
    expect(r.unmatched[0]!.description).toBe("SOME LOCAL SHOP LTD");
    expect(r.classifications).toHaveLength(1);
  });

  it("asserts rather than estimates — a rule is confidence 1", () => {
    // If a rule is wrong the rule should be fixed, not hedged with a lower
    // number that quietly downweights it everywhere.
    const r = applyRules([cand("ALDI 998")]);
    expect(r.classifications[0]!.confidence).toBe(1);
  });

  it("does not confuse Uber Eats with Uber", () => {
    const r = applyRules([cand("UBER EATS LONDON"), cand("UBER TRIP HELP.UBER.COM")]);
    const byDesc = new Map(r.classifications.map((c) => [c.dedupKey, c.category]));
    expect(byDesc.get("n:UBER EATS LONDON")).toBe("Eating Out");
    expect(byDesc.get("n:UBER TRIP HELP.UBER.COM")).toBe("Transport");
  });

  it("only ever produces categories from the taxonomy", () => {
    for (const rule of RULES) {
      expect(isCategory(rule.category)).toBe(true);
    }
  });

  it("is order-independent for a given transaction", () => {
    const a = applyRules([cand("BOOTS 123"), cand("ALDI 1")]);
    const b = applyRules([cand("ALDI 1"), cand("BOOTS 123")]);
    const map = (r: ReturnType<typeof applyRules>) =>
      new Map(r.classifications.map((c) => [c.dedupKey, c.category]));
    expect(map(a).get("n:BOOTS 123")).toBe(map(b).get("n:BOOTS 123"));
  });
});

describe("direction", () => {
  it("never applies a merchant rule to money in", () => {
    // Against the real ledger, 48 credits of roughly £5,000 matched an AMAZON
    // rule and were filed as Shopping. They were salary — a large employer
    // sharing a name with a large retailer. A rule cannot distinguish a refund
    // from income, so it must not try.
    const r = applyRules([cand("AMAZON PAYROLL", { amount: 527818 })]);
    expect(r.classifications).toHaveLength(0);
    expect(r.unmatched).toHaveLength(1);
  });

  it("still applies merchant rules to money out", () => {
    const r = applyRules([cand("AMAZON MKTPLACE", { amount: -2499 })]);
    expect(r.classifications[0]!.category).toBe("Shopping");
  });

  it("reads interest by direction, not by label", () => {
    const paid = applyRules([cand("INTEREST", { amount: -500, providerCategory: "INTEREST" })]);
    const received = applyRules([cand("INTEREST", { amount: 500, providerCategory: "INTEREST" })]);
    expect(paid.classifications[0]!.category).toBe("Fees & Charges");
    expect(received.classifications[0]!.category).toBe("Income");
  });
});

describe("brand names as they actually appear on statements", () => {
  // A trailing \b after a singular brand cannot match the possessive or plural
  // form, which is the form banks print. "SAINSBURYS S/MKTS" went uncategorised
  // for 22 transactions against a rule that looked correct.
  const cases: Array<[string, string]> = [
    ["SAINSBURYS S/MKTS EDINBURGH", "Groceries"],
    ["SAINSBURY'S LOCAL", "Groceries"],
    ["MORRISONS PETROL", "Groceries"],
    ["MCDONALDS 1234 LEEDS", "Eating Out"],
    ["NANDO'S CARDIFF", "Eating Out"],
    ["MICROSOFT*ULTIMATE MSBILL.INFO", "Subscriptions"],
  ];

  for (const [description, expected] of cases) {
    it(`files "${description}" as ${expected}`, () => {
      const [result] = applyRules([
        { dedupKey: "k", description, amount: -1234, currency: "GBP" },
      ]).classifications;
      expect(result?.category).toBe(expected);
    });
  }
});

describe("enrichmentMetrics", () => {
  const prepared = {
    candidates: [{ dedupKey: "a" }, { dedupKey: "b" }, { dedupKey: "c" }],
    classifications: [{ dedupKey: "a" }, { dedupKey: "b" }],
    unmatched: [{ dedupKey: "c" }],
    customRuleCount: 16,
  } as never;

  it("reports the backlog, what matched, and what was left", () => {
    expect(enrichmentMetrics(prepared, 2)).toEqual({
      EnrichmentBacklog: 3,
      EnrichmentMatched: 2,
      EnrichmentWritten: 2,
      EnrichmentUnmatched: 1,
      CustomRules: 16,
    });
  });

  it("distinguishes matched from written", () => {
    // They differ when a transaction disappears between listing and writing,
    // and a run that matched plenty while writing nothing is worth seeing.
    expect(enrichmentMetrics(prepared, 0)["EnrichmentWritten"]).toBe(0);
    expect(enrichmentMetrics(prepared, 0)["EnrichmentMatched"]).toBe(2);
  });
});
