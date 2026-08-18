import { describe, it, expect } from "vitest";
import { Categorisation, Matcher, Contribution, Rule, RuleSet, RowKind, keys } from "./index";

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
    expect(Contribution.parse({ kind: "tag", tag: "reviewed" }).kind).toBe("tag");
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
    // The provider's own classification has no rule we can name, which is why
    // `rules` is a list with a default rather than a single optional reference.
    const c = Categorisation.parse({
      dedupKey: "d1",
      timestamp: "2026-03-01T00:00:00Z",
      category: "PURCHASE",
      setId: "provider",
      setVersion: 20260817,
      version: 1,
      status: "effective",
      appliedAt: "2026-08-17T05:00:00Z",
    });
    expect(c.rules).toEqual([]);
    expect(c.tags).toEqual([]);
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

describe("keys", () => {
  it("sorts a categorisation into the transaction's own partition", () => {
    // CAT sorts before EN and TX within a timestamp, so one range query returns
    // a transaction with its categorisations. No new access pattern.
    const tx = keys.transaction("frost", "2026-03-01T00:00:00Z", "d1");
    const cat = keys.categorisation("frost", "2026-03-01T00:00:00Z", "d1", "household");
    expect(cat.pk).toBe(tx.pk);
    expect(cat.sk < tx.sk).toBe(true);
    expect(RowKind.categorisation < RowKind.enrichment).toBe(true);
  });

  it("gives each set its own current row, so two sets cannot collide", () => {
    // Keyed by set rather than by version. Without the set id, two sets both at
    // version 1 produce the same key and the household set silently overwrites
    // the built-in one — and per-set rows are what make selective re-firing
    // possible at all.
    const a = keys.categorisation("frost", "2026-03-01T00:00:00Z", "d1", "household");
    const b = keys.categorisation("frost", "2026-03-01T00:00:00Z", "d1", "built-in");
    expect(a.sk).not.toBe(b.sk);
  });

  it("keeps categorisation history out of the batch read", () => {
    // The dominant read is a range over many transactions. History in that
    // partition would make it grow with churn rather than with transactions, so
    // versions live under their own partition and are fetched only on demand.
    const current = keys.categorisation("frost", "2026-03-01T00:00:00Z", "d1", "household");
    const history = keys.categorisationVersion("frost", "d1", "household", 1);
    expect(history.pk).not.toBe(current.pk);
  });

  it("orders categorisation versions numerically, so 10 follows 9", () => {
    // Zero-padded. Lexically "10" precedes "9", which would make the newest
    // version of a long-lived categorisation invisible.
    const v = (n: number) => keys.categorisationVersion("frost", "d1", "household", n).sk;
    expect([v(10), v(9), v(1)].sort()).toEqual([v(1), v(9), v(10)]);
  });

  it("returns only current rule sets from the prefix a fold run reads", () => {
    // begins_with("RULESET#") must not drag in history. The two prefixes are
    // deliberately disjoint: "RULESETH" does not begin with "RULESET#".
    const current = keys.ruleSet("frost", "household").sk;
    const history = keys.ruleSetVersion("frost", "household", 3);
    expect(current.startsWith("RULESET#")).toBe(true);
    expect(history.sk.startsWith("RULESET#")).toBe(false);
    expect(history.pk).not.toBe(keys.ruleSet("frost", "household").pk);
  });

  it("orders rule set versions numerically too", () => {
    const v = (n: number) => keys.ruleSetVersion("frost", "household", n).sk;
    expect([v(10), v(2)].sort()).toEqual([v(2), v(10)]);
  });
});
