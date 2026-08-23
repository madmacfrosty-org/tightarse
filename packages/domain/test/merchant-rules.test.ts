import { describe, it, expect } from "vitest";
import { RULES } from "../src/categorisation/merchant-rules.js";
import { seedRuleSets } from "../src/categorisation/seed.js";
import { evaluate } from "../src/categorisation/evaluate.js";
import type { Candidate } from "../src/categorisation/taxonomy.js";

const cand = (description: string, over: Partial<Candidate> = {}): Candidate => ({
  dedupKey: `n:${description}`,
  description,
  amount: -1299,
  currency: "GBP",
  ...over,
});

/**
 * The shipped patterns, driven the way they are actually used.
 *
 * They used to be tested through `applyRules`, the matcher that rule sets
 * replaced. Testing them through `evaluate` over the seeded set keeps what was
 * worth keeping — that these patterns match real statement formats — and points
 * it at the path that runs.
 */
describe("brand names as they actually appear on statements", () => {
  const builtIn = seedRuleSets({ now: new Date("2026-01-01T00:00:00.000Z") }).find((s) => s.setId === "built-in")!;

  const categoryOf = (description: string, over: Partial<Candidate> = {}) =>
    evaluate([builtIn], {
      dedupKey: "d1",
      description,
      amount: -10_00,
      currency: "GBP",
      ...over,
    }).effective?.category;

  it.each([
    ["TESCO STORES 3456 LONDON", "groceries"],
    ["SHELL 12345 M4 SERVICES", "fuel"],
    ["NETFLIX.COM 4567", "subscriptions"],
    ["SAINSBURYS S/MKT 0123", "groceries"],
    ["MCDONALDS 4567 LONDON", "eating-out"],
    ["TFL TRAVEL CH LONDON", "transport"],
  ])("places %s", (description, expected) => {
    expect(categoryOf(description)).toBe(expected);
  });

  it("uses the provider type for cash, where the description is a place not a merchant", () => {
    // An ATM withdrawal's description is usually a location, and the provider's
    // own transaction type is far more reliable than trying to read it.
    const provider = seedRuleSets({ now: new Date("2026-01-01T00:00:00.000Z") }).find((s) => s.setId === "provider")!;
    expect(
      evaluate([provider], {
        dedupKey: "d1",
        description: "HIGH STREET BRANCH",
        amount: -50_00,
        currency: "GBP",
        providerCategory: "ATM",
      }).effective?.category,
    ).toBe("cash-withdrawal");
  });

  it("leaves an unfamiliar merchant alone rather than guessing", () => {
    expect(categoryOf("ZZQX TRADING LTD")).toBeUndefined();
  });
});
