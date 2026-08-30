import { describe, it, expect } from "vitest";
import { gatherEvidence } from "../src/categorisation/evidence.js";
import type { Rule, RuleSet } from "../src/categorisation/rules.js";
import type { Candidate } from "../src/categorisation/taxonomy.js";

/**
 * Measuring what rules do to a ledger.
 *
 * These numbers are the whole basis for changing a rule safely: breadth decides
 * whether a pattern has escaped, conflicts name a defect, and the gaps are where
 * the next rule comes from. Merchants here are invented.
 */

const tx = (description: string, amount = -10_00): Candidate => ({
  dedupKey: `d-${description}-${amount}`,
  description,
  amount,
  currency: "GBP",
});

const asserts = (pattern: string, category: string): Rule => ({
  matcher: { kind: "merchant", pattern },
  contributes: { kind: "assert", category },
  appliesTo: "debits",
});

const refines = (pattern: string, category: string): Rule => ({
  matcher: { kind: "merchant", pattern },
  contributes: { kind: "refine", category },
  appliesTo: "debits",
});

const set = (setId: string, order: number, rules: Rule[]): RuleSet => ({
  setId,
  version: 1,
  name: setId,
  order,
  authored: false,
  status: "effective",
  rules,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("how far a rule reaches", () => {
  it("counts transactions and distinct merchants separately", () => {
    // The pair is the point. 400 transactions at one merchant is narrow and
    // probably right; 400 across 200 merchants is a rule that has escaped, and
    // a transaction count alone cannot tell those apart.
    const sets = [set("built-in", 2, [asserts("somemart", "groceries")])];
    const corpus = [
      tx("SOMEMART 1"),
      tx("SOMEMART 1"),
      tx("SOMEMART 2"),
      tx("ELSEWHERE"),
    ];
    const e = gatherEvidence(sets, corpus);
    expect(e.reach[0]).toMatchObject({
      setId: "built-in",
      index: 0,
      transactions: 3,
      merchants: 2,
    });
  });

  it("reports a rule that matches nothing, rather than omitting it", () => {
    // A rule matching nothing is dead weight nobody can justify keeping, and it
    // is invisible if only matching rules are listed.
    const sets = [
      set("built-in", 2, [
        asserts("somemart", "groceries"),
        asserts("nowhere", "shopping"),
      ]),
    ];
    const e = gatherEvidence(sets, [tx("SOMEMART 1")]);
    expect(e.reach).toHaveLength(2);
    expect(e.reach[1]).toMatchObject({
      index: 1,
      transactions: 0,
      merchants: 0,
    });
  });

  it("does not count a rule against a credit it excludes", () => {
    const sets = [set("built-in", 2, [asserts("somemart", "groceries")])];
    const e = gatherEvidence(sets, [tx("SOMEMART 1", 2_500_00)]);
    expect(e.reach[0]?.transactions).toBe(0);
  });
});

describe("conflicts", () => {
  it("groups a conflict by the rules that collided, not by transaction", () => {
    // Thirty transactions hitting one bad pair is one defect to fix, not thirty
    // findings to read.
    const sets = [
      set("built-in", 2, [
        asserts("somemart", "groceries"),
        asserts("store", "shopping"),
      ]),
    ];
    const corpus = [
      tx("SOMEMART STORE 1"),
      tx("SOMEMART STORE 2"),
      tx("SOMEMART STORE 3"),
    ];
    const e = gatherEvidence(sets, corpus);
    expect(e.conflicts).toHaveLength(1);
    expect(e.conflicts[0]).toMatchObject({
      setId: "built-in",
      rules: [0, 1],
      categories: ["groceries", "shopping"],
      transactions: 3,
    });
  });

  it("names a transaction it happens on, so a human can see which rule is wrong", () => {
    const sets = [
      set("built-in", 2, [
        asserts("somemart", "groceries"),
        asserts("store", "shopping"),
      ]),
    ];
    const e = gatherEvidence(sets, [tx("SOMEMART STORE 1")]);
    expect(e.conflicts[0]?.example).toBe("SOMEMART STORE 1");
  });

  it("keeps two sets' conflicts apart when they collide at the same positions", () => {
    // Both sets conflict on rules 0 and 1. If the key that groups them left the
    // set out, one would absorb the other and a defect would vanish from the
    // report.
    const sets = [
      set("household", 0, [asserts("aaa", "one"), asserts("aa", "two")]),
      set("built-in", 2, [asserts("aaa", "three"), asserts("aa", "four")]),
    ];
    const e = gatherEvidence(sets, [tx("AAA")]);
    expect(e.conflicts).toHaveLength(2);
    expect(e.conflicts.map((c) => c.setId).sort()).toEqual([
      "built-in",
      "household",
    ]);
  });

  it("does not call an assert and a refine a conflict", () => {
    const sets = [
      set("built-in", 2, [
        asserts("somemart", "groceries"),
        refines("forecourt", "fuel"),
      ]),
    ];
    expect(gatherEvidence(sets, [tx("SOMEMART FORECOURT")]).conflicts).toEqual(
      [],
    );
  });

  it("orders conflicts by how much of the ledger they affect", () => {
    const sets = [
      set("a", 1, [asserts("x", "one"), asserts("xx", "two")]),
      set("b", 2, [asserts("y", "three"), asserts("yy", "four")]),
    ];
    const corpus = [tx("YY"), tx("YY"), tx("YY"), tx("XX")];
    const e = gatherEvidence(sets, corpus);
    expect(e.conflicts[0]?.setId).toBe("b");
  });
});

describe("inert refines", () => {
  it("reports a qualifier that matched with nothing established", () => {
    // Each one names a missing assert: we know it is a forecourt, but not whose.
    const sets = [set("built-in", 2, [refines("forecourt", "fuel")])];
    const e = gatherEvidence(sets, [tx("A FORECOURT"), tx("A FORECOURT")]);
    expect(e.inertRefines[0]).toMatchObject({
      setId: "built-in",
      index: 0,
      category: "fuel",
      transactions: 2,
    });
  });

  it("keeps two sets' inert refines apart at the same position", () => {
    const sets = [
      set("household", 0, [refines("forecourt", "fuel")]),
      set("built-in", 2, [refines("forecourt", "transport")]),
    ];
    const e = gatherEvidence(sets, [tx("A FORECOURT")]);
    expect(e.inertRefines).toHaveLength(2);
  });

  it("orders inert refines by how much of the ledger they affect", () => {
    const sets = [
      set("built-in", 2, [refines("aaa", "one"), refines("bbb", "two")]),
    ];
    const e = gatherEvidence(sets, [tx("BBB"), tx("BBB"), tx("AAA")]);
    expect(e.inertRefines[0]).toMatchObject({ index: 1, transactions: 2 });
  });

  it("says nothing when the refine had something to refine", () => {
    const sets = [
      set("built-in", 2, [
        asserts("somemart", "groceries"),
        refines("forecourt", "fuel"),
      ]),
    ];
    expect(
      gatherEvidence(sets, [tx("SOMEMART FORECOURT")]).inertRefines,
    ).toEqual([]);
  });
});

describe("the gaps", () => {
  it("collects what nothing matched, costliest first", () => {
    const sets = [set("built-in", 2, [asserts("somemart", "groceries")])];
    const corpus = [
      tx("UNKNOWN A"),
      tx("UNKNOWN B"),
      tx("UNKNOWN B"),
      tx("SOMEMART"),
    ];
    const e = gatherEvidence(sets, corpus);
    expect(e.gaps[0]).toEqual({
      description: "UNKNOWN B",
      transactions: 2,
      outgoing: 20_00,
    });
    expect(e.gaps.map((g) => g.description)).not.toContain("SOMEMART");
  });

  it("ranks by value, not by how often something happened", () => {
    // The orderings genuinely disagree: frequent gaps are small recurring
    // spends, and a rule is worth writing for the money it accounts for.
    const sets = [set("built-in", 2, [])];
    const corpus = [
      tx("FREQUENT", -1_00),
      tx("FREQUENT", -1_00),
      tx("FREQUENT", -1_00),
      tx("EXPENSIVE", -400_00),
    ];
    const e = gatherEvidence(sets, corpus);
    expect(e.gaps.map((g) => g.description)).toEqual(["EXPENSIVE", "FREQUENT"]);
  });

  it("counts a credit as a sighting but not as money leaving", () => {
    const sets = [set("built-in", 2, [])];
    const e = gatherEvidence(sets, [tx("REFUND", 25_00), tx("REFUND", -5_00)]);
    expect(e.gaps[0]).toEqual({
      description: "REFUND",
      transactions: 2,
      outgoing: 5_00,
    });
  });

  it("counts a transaction matched by any set as covered, not just the winning one", () => {
    // A lower-precedence set answering is still an answer; listing it as a gap
    // would send someone writing a rule that already exists.
    const sets = [
      set("household", 0, [asserts("nothing", "x")]),
      set("built-in", 2, [asserts("somemart", "groceries")]),
    ];
    expect(gatherEvidence(sets, [tx("SOMEMART")]).gaps).toEqual([]);
  });

  it("orders equal values by description, so two runs agree", () => {
    const sets = [set("built-in", 2, [])];
    const e = gatherEvidence(sets, [tx("BBB"), tx("AAA")]);
    expect(e.gaps.map((g) => g.description)).toEqual(["AAA", "BBB"]);
  });

  it("reports how much it looked at", () => {
    expect(gatherEvidence([], [tx("A"), tx("B")]).scanned).toBe(2);
  });
});
