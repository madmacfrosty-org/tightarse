import { describe, it, expect } from "vitest";
import { Categorisation, Matcher, Contribution, Rule, RuleSet } from "../src/index.js";

describe("matchers", () => {
  it("are predicates over a transaction, not only patterns over a string", () => {
    // A merchant pattern, a provider value and a single transaction are all ways
    // of selecting one — which is what lets an override be expressed as a rule
    // without inventing a second mechanism.
    expect(Matcher.parse({ kind: "merchant", pattern: "^SOMESHOP" }).kind).toBe("merchant");
    expect(Matcher.parse({ kind: "providerCategory", value: "ATM" }).kind).toBe("providerCategory");
    expect(Matcher.parse({ kind: "transaction", dedupKey: "d1" }).kind).toBe("transaction");
  });

  it("rejects an unknown kind rather than accepting it silently", () => {
    expect(() => Matcher.parse({ kind: "vibes", pattern: "x" })).toThrow();
  });
});

describe("contributions", () => {
  it("are a small closed algebra", () => {
    // assert puts a category on the table, refine changes one already there, tag
    // attaches an attribute. Arbitrary transforms would produce rule sets nobody
    // can reason about.
    expect(Contribution.parse({ kind: "assert", category: "Groceries" }).kind).toBe("assert");
    expect(Contribution.parse({ kind: "refine", category: "Fuel" }).kind).toBe("refine");
    // Two kinds only: `tag` was specified, never used, and dropped.
    expect(() => Contribution.parse({ kind: "tag", tag: "reviewed" })).toThrow();
    expect(() => Contribution.parse({ kind: "replace", category: "Fuel" })).toThrow();
  });
});

describe("a rule", () => {
  it("excludes credits unless told otherwise", () => {
    // An employer sharing a name with a retailer once filed £62,868 of salary as
    // Shopping. The default is the safe direction.
    const r = Rule.parse({
      matcher: { kind: "merchant", pattern: "^SOMESHOP" },
      contributes: { kind: "assert", category: "Groceries" },
    });
    expect(r.appliesTo).toBe("debits");
    expect(Rule.parse({ ...r, appliesTo: "all" }).appliesTo).toBe("all");
  });

  it("carries no id and no enabled flag", () => {
    // A rule is a value. Editing produces a new set version; disabling is a set
    // version without it. Identity, where needed, is the content hash.
    const r = Rule.parse({
      matcher: { kind: "merchant", pattern: "^SOMESHOP" },
      contributes: { kind: "assert", category: "Groceries" },
      id: "should-be-dropped",
      enabled: false,
    } as never);
    expect("id" in r).toBe(false);
    expect("enabled" in r).toBe(false);
  });
});

describe("a rule set", () => {
  it("records its precedence and whether it may be regenerated", () => {
    // `order` decides whether a model-proposed rule can outrank a hand-written
    // one; `authored` decides whether regeneration may touch it at all.
    const s = RuleSet.parse({
      setId: "household",
      version: 3,
      name: "Household",
      order: 100,
      authored: true,
      rules: [],
      createdAt: "2026-08-17T00:00:00Z",
    });
    expect(s.order).toBe(100);
    expect(s.authored).toBe(true);
  });
});

describe("a categorisation", () => {
  it("always names the set and version, and may name no rule at all", () => {
    // Parses without a rule reference: the provider's own classification has no
    // rule anybody can name, and nothing invents one.
    expect(() =>
      Categorisation.parse({
        dedupKey: "d1",
        timestamp: "2026-03-01T00:00:00Z",
        category: "PURCHASE",
        setId: "provider",
        setVersion: 20260817,
        version: 1,
        status: "effective",
        appliedAt: "2026-08-17T05:00:00Z",
      }),
    ).not.toThrow();
  });

  it("refuses version zero, because versions are a history not an index", () => {
    const base = {
      dedupKey: "d1",
      timestamp: "2026-03-01T00:00:00Z",
      category: "Groceries",
      setId: "household",
      setVersion: 1,
      status: "effective" as const,
      appliedAt: "2026-08-17T05:00:00Z",
    };
    expect(() => Categorisation.parse({ ...base, version: 0 })).toThrow();
    expect(Categorisation.parse({ ...base, version: 1 }).version).toBe(1);
  });

  it("rejects a status it cannot act on", () => {
    expect(() =>
      Categorisation.parse({
        dedupKey: "d1",
        timestamp: "2026-03-01T00:00:00Z",
        category: "Groceries",
        setId: "household",
        setVersion: 1,
        version: 1,
        status: "maybe",
        appliedAt: "2026-08-17T05:00:00Z",
      }),
    ).toThrow();
  });
});

