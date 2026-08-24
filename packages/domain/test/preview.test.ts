import { describe, it, expect } from "vitest";
import { preview } from "../src/categorisation/preview.js";
import type { Rule, RuleSet } from "../src/categorisation/rules.js";
import type { Candidate } from "../src/categorisation/taxonomy.js";

/**
 * What a proposed rule change would do to a ledger.
 *
 * The case this exists for is the generalisation that looks free: a pattern
 * widened to catch a chain, which also quietly takes transactions a narrower
 * rule had already filed correctly. Reach reports that as a win. Only a diff of
 * the answers reports it as a theft.
 *
 * Merchants here are invented. Real ones are household data and do not go in
 * files.
 */

const tx = (description: string, amount = -10_00): Candidate => ({
  dedupKey: `d-${description}-${amount}`,
  description,
  amount,
  currency: "GBP",
});

const asserts = (pattern: string, category: string, appliesTo: Rule["appliesTo"] = "debits"): Rule => ({
  matcher: { kind: "merchant", pattern },
  contributes: { kind: "assert", category },
  appliesTo,
});

const refines = (pattern: string, category: string): Rule => ({
  matcher: { kind: "merchant", pattern },
  contributes: { kind: "refine", category },
  appliesTo: "debits",
});

const set = (over: Partial<RuleSet> & { setId: string; order: number; rules: Rule[] }): RuleSet => ({
  version: 1,
  name: over.setId,
  authored: false,
  status: "effective" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

/** The shipped set, which a household rule outranks. */
const builtIn = (rules: Rule[]) => set({ setId: "built-in", order: 2, rules });
/** A household proposal always arrives as a new version. */
const household = (rules: Rule[], version = 1) => set({ setId: "household", order: 0, rules, version });
const overrides = (rules: Rule[]) => set({ setId: "overrides", order: -1, rules });

describe("what a proposal wins", () => {
  it("reports a category where nothing matched before", () => {
    const p = preview([builtIn([])], [builtIn([]), household([asserts("somemart", "groceries")])], [tx("SOMEMART 118")]);

    expect(p.gained).toMatchObject({ transactions: 1, outgoing: 10_00, merchants: 1 });
    expect(p.gained.entries[0]).toEqual({
      dedupKey: "d-SOMEMART 118--1000",
      description: "SOMEMART 118",
      from: undefined,
      to: "groceries",
    });
  });

  it("counts distinct descriptions, so a pattern that escaped is visible", () => {
    const after = [household([asserts("shop", "groceries")])];
    const p = preview([], after, [tx("SHOP ONE"), tx("SHOP TWO"), tx("SHOP TWO")]);

    expect(p.gained).toMatchObject({ transactions: 3, merchants: 2 });
  });

  it("counts a credit as a transaction but not as money leaving", () => {
    const after = [household([asserts("refund", "shopping", "all")])];
    const p = preview([], after, [tx("REFUND", 25_00), tx("REFUND", -5_00)]);

    expect(p.gained).toMatchObject({ transactions: 2, outgoing: 5_00 });
  });
});

describe("what a proposal takes", () => {
  it("names the transactions it would recategorise, not just the ones it wins", () => {
    const before = [builtIn([asserts("somemart", "groceries")])];
    const after = [...before, household([asserts("somemart", "fuel")])];
    const p = preview(before, after, [tx("SOMEMART FORECOURT")]);

    expect(p.gained.transactions).toBe(0);
    expect(p.recategorised).toMatchObject({ transactions: 1, outgoing: 10_00 });
    expect(p.recategorised.entries[0]).toMatchObject({ from: "groceries", to: "fuel" });
  });

  it("reports a category lost outright when the proposal makes its set disagree with itself", () => {
    const before = [household([asserts("somemart", "groceries")])];
    const after = [household([asserts("somemart", "groceries"), asserts("somemart", "fuel")], 2)];
    const p = preview(before, after, [tx("SOMEMART 118")]);

    expect(p.lost).toMatchObject({ transactions: 1 });
    expect(p.lost.entries[0]).toMatchObject({ from: "groceries", to: undefined });
    expect(p.recategorised.transactions).toBe(0);
  });
});

describe("what a proposal does not change", () => {
  it("separates agreeing with what was there from being beaten to it", () => {
    const before = [builtIn([asserts("somemart", "groceries")])];
    const after = [...before, household([asserts("somemart", "groceries")])];

    expect(preview(before, after, [tx("SOMEMART 118")]).unchanged.transactions).toBe(1);
  });

  it("reports a rule that matched and lost, which otherwise looks like one that does nothing", () => {
    const before = [overrides([asserts("somemart", "fuel")]), builtIn([])];
    const after = [...before, household([asserts("somemart", "groceries")])];
    const p = preview(before, after, [tx("SOMEMART 118")]);

    expect(p.outranked).toMatchObject({ transactions: 1 });
    expect(p.outranked.entries[0]).toMatchObject({ from: "fuel", to: "fuel" });
    expect(p.unchanged.transactions).toBe(0);
  });

  it("leaves the backlog alone: uncategorised before and after is not a change", () => {
    // The common case, and the one most likely to be mishandled — most of a
    // ledger is transactions no rule touches, before or after.
    const before = [builtIn([asserts("somemart", "groceries")])];
    const after = [...before, household([asserts("othershop", "shopping")], 2)];
    const p = preview(before, after, [tx("NOTHING MATCHES THIS")]);

    for (const effect of [p.gained, p.lost, p.recategorised, p.unchanged, p.outranked])
      expect(effect.transactions).toBe(0);
    expect(p.scanned).toBe(1);
  });

  it("says nothing at all about transactions the proposal never mentions", () => {
    const before = [builtIn([asserts("somemart", "groceries")])];
    const after = [...before, household([asserts("othershop", "shopping")])];
    const p = preview(before, after, [tx("SOMEMART 118")]);

    for (const effect of [p.gained, p.lost, p.recategorised, p.unchanged, p.outranked])
      expect(effect.transactions).toBe(0);
  });

  it("treats a set at the same version as unproposed, however its rules read", () => {
    // A caller editing rules without advancing the version is lying about what
    // it did, and this is where that shows up as silence.
    const sets = [household([asserts("somemart", "groceries")])];
    const p = preview(sets, sets, [tx("SOMEMART 118")]);

    expect(p.unchanged.transactions).toBe(0);
    expect(p.scanned).toBe(1);
  });
});

describe("conflicts the proposal introduces", () => {
  it("names the set and the categories it can no longer choose between", () => {
    const before = [household([asserts("somemart", "groceries")])];
    const after = [household([asserts("somemart", "groceries"), asserts("somemart", "fuel")], 2)];
    const p = preview(before, after, [tx("SOMEMART 118"), tx("SOMEMART 42")]);

    expect(p.introducedConflicts).toEqual([
      { setId: "household", categories: ["groceries", "fuel"], transactions: 2, example: "SOMEMART 118" },
    ]);
  });

  it("blames the proposal for nothing that was already broken", () => {
    const clash = [asserts("somemart", "groceries"), asserts("somemart", "fuel")];
    const before = [household(clash)];
    const after = [household([...clash, asserts("othershop", "shopping")], 2)];

    expect(preview(before, after, [tx("SOMEMART 118")]).introducedConflicts).toEqual([]);
  });

  it("does not mistake a qualifier with nothing to qualify for a conflict", () => {
    // An inert refine is a problem too, and a different one. Reporting it here
    // would send someone hunting for two rules that disagree when there is one
    // rule with nothing to attach to.
    const before = [household([])];
    const after = [household([refines("forecourt", "fuel")], 2)];
    const p = preview(before, after, [tx("SOMEMART FORECOURT")]);

    expect(p.introducedConflicts).toEqual([]);
    expect(p.gained.transactions).toBe(0);
  });

  it("does not trip over a qualifier the set was already missing an assert for", () => {
    const before = [household([refines("forecourt", "fuel")])];
    const after = [household([refines("forecourt", "fuel"), asserts("somemart", "groceries")], 2)];
    const p = preview(before, after, [tx("SOMEMART FORECOURT")]);

    // The qualifier still fires before the assert establishes anything, so it
    // stays inert and the assert wins. Inert, but not a conflict.
    expect(p.introducedConflicts).toEqual([]);
    expect(p.gained.entries[0]).toMatchObject({ from: undefined, to: "groceries" });
  });

  it("blames the proposal for nothing in a set it did not touch", () => {
    const broken = builtIn([asserts("somemart", "groceries"), asserts("somemart", "fuel")]);
    const before = [broken, household([])];
    const after = [broken, household([asserts("othershop", "shopping")], 2)];

    expect(preview(before, after, [tx("SOMEMART 118")]).introducedConflicts).toEqual([]);
  });

  it("breaks a tie by set, so two runs agree", () => {
    const before = [household([]), set({ setId: "assisted", order: 1, rules: [] })];
    const after = [
      household([asserts("somemart", "groceries"), asserts("somemart", "fuel")], 2),
      set({ setId: "assisted", order: 1, version: 2, rules: [asserts("othershop", "a"), asserts("othershop", "b")] }),
    ];
    const p = preview(before, after, [tx("SOMEMART 118"), tx("OTHERSHOP")]);

    expect(p.introducedConflicts.map((c) => [c.setId, c.transactions])).toEqual([
      ["assisted", 1],
      ["household", 1],
    ]);
  });

  it("puts the widest conflict first, and breaks ties by set so two runs agree", () => {
    const before = [household([]), set({ setId: "assisted", order: 1, rules: [] })];
    const after = [
      household([asserts("somemart", "groceries"), asserts("somemart", "fuel")], 2),
      set({ setId: "assisted", order: 1, version: 2, rules: [asserts("othershop", "a"), asserts("othershop", "b")] }),
    ];
    const p = preview(before, after, [tx("SOMEMART 118"), tx("OTHERSHOP"), tx("OTHERSHOP 2")]);

    expect(p.introducedConflicts.map((c) => [c.setId, c.transactions])).toEqual([
      ["assisted", 2],
      ["household", 1],
    ]);
  });
});

describe("the preview as a whole", () => {
  it("reports how much it looked at", () => {
    expect(preview([], [], [tx("A"), tx("B")]).scanned).toBe(2);
  });

  it("has nothing to say about an empty ledger", () => {
    const p = preview([], [household([asserts("somemart", "groceries")])], []);

    expect(p).toMatchObject({ scanned: 0, introducedConflicts: [] });
    expect(p.gained.entries).toEqual([]);
  });
});
