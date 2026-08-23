import { describe, it, expect } from "vitest";
import { conflictResolver, resolve } from "../src/conflict-resolver.js";
import type { Evidence, Rule, RuleSet } from "@tightarse/domain";

/**
 * The deterministic proposer.
 *
 * One opinion — where two asserts collide, the narrower becomes a refine — and
 * the tests are mostly about what it refuses to touch. A proposer that edits an
 * authored set is the failure the custody rule exists to prevent.
 */

const asserts = (pattern: string, category: string): Rule => ({
  matcher: { kind: "merchant", pattern },
  contributes: { kind: "assert", category },
  appliesTo: "debits",
});

const set = (setId: string, rules: Rule[], authored = false): RuleSet => ({
  setId,
  version: 3,
  name: setId,
  order: authored ? 0 : 2,
  authored,
  rules,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const evidence = (over: Partial<Evidence> = {}): Evidence => ({
  reach: [],
  conflicts: [],
  inertRefines: [],
  gaps: [],
  scanned: 100,
  ...over,
});

const reach = (setId: string, index: number, transactions: number, merchants: number) => ({
  setId,
  index,
  transactions,
  merchants,
});

describe("resolving a collision", () => {
  const sets = [set("built-in", [asserts("somemart", "groceries"), asserts("forecourt", "fuel")])];
  const e = evidence({
    conflicts: [
      { setId: "built-in", categories: ["groceries", "fuel"], rules: [0, 1], transactions: 30, example: "X" },
    ],
    reach: [reach("built-in", 0, 1900, 40), reach("built-in", 1, 60, 1)],
  });

  it("makes the narrower rule refine the broader one", () => {
    // 1,900 transactions across 40 merchants names the shop; 60 at one merchant
    // is a qualifier. That is the forecourt shape, derived rather than listed.
    const [proposed] = resolve(e, sets);
    expect(proposed?.rules[0]?.contributes).toEqual({ kind: "assert", category: "groceries" });
    expect(proposed?.rules[1]?.contributes).toEqual({ kind: "refine", category: "fuel" });
  });

  it("keeps the category the narrow rule was asserting", () => {
    // Converting the kind, not the answer. A refine to a different category
    // would be inventing a decision nobody made.
    const [proposed] = resolve(e, sets);
    expect(proposed?.rules[1]?.contributes).toMatchObject({ category: "fuel" });
  });

  it("breaks a tie on merchants by transaction count", () => {
    const tied = evidence({
      conflicts: [{ setId: "built-in", categories: ["a", "b"], rules: [0, 1], transactions: 5, example: "X" }],
      reach: [reach("built-in", 0, 900, 3), reach("built-in", 1, 20, 3)],
    });
    const [proposed] = resolve(tied, sets);
    expect(proposed?.rules[1]?.contributes.kind).toBe("refine");
    expect(proposed?.rules[0]?.contributes.kind).toBe("assert");
  });

  it("resolves a three-way collision in one pass", () => {
    // Leaving the broadest asserting and refining the rest, rather than needing
    // another round to notice the second pair.
    const three = [set("built-in", [asserts("a", "one"), asserts("b", "two"), asserts("c", "three")])];
    const e3 = evidence({
      conflicts: [{ setId: "built-in", categories: ["one", "two", "three"], rules: [0, 1, 2], transactions: 4, example: "X" }],
      reach: [reach("built-in", 0, 900, 30), reach("built-in", 1, 50, 4), reach("built-in", 2, 10, 1)],
    });
    const [proposed] = resolve(e3, three);
    expect(proposed?.rules.map((r) => r.contributes.kind)).toEqual(["assert", "refine", "refine"]);
  });

  it("keeps the earlier rule asserting when two are exactly as broad", () => {
    // Position within a set is deliberate data, so it is the right tie-break:
    // the rule the author put first is the one that keeps naming the category.
    const tied = evidence({
      conflicts: [{ setId: "built-in", categories: ["a", "b"], rules: [0, 1], transactions: 5, example: "X" }],
      reach: [reach("built-in", 0, 100, 5), reach("built-in", 1, 100, 5)],
    });
    const [proposed] = resolve(tied, sets);
    expect(proposed?.rules[0]?.contributes.kind).toBe("assert");
    expect(proposed?.rules[1]?.contributes.kind).toBe("refine");
  });

  it("still resolves when it has no reach figures for a rule", () => {
    // Evidence and sets are gathered separately. A rule with no measurement is
    // treated as reaching nothing, which makes it the narrower one — and that
    // beats refusing to act on an incomplete picture.
    const noReach = evidence({
      conflicts: [{ setId: "built-in", categories: ["a", "b"], rules: [0, 1], transactions: 5, example: "X" }],
      reach: [reach("built-in", 0, 900, 30)],
    });
    const [proposed] = resolve(noReach, sets);
    expect(proposed?.rules[1]?.contributes.kind).toBe("refine");
  });

  it("falls back to position when it has no figures for either rule", () => {
    // Both unmeasured, so both count as reaching nothing and the tie-break is
    // the order the author wrote them in.
    const blind = evidence({
      conflicts: [{ setId: "built-in", categories: ["a", "b"], rules: [0, 1], transactions: 5, example: "X" }],
      reach: [],
    });
    const [proposed] = resolve(blind, sets);
    expect(proposed?.rules.map((r) => r.contributes.kind)).toEqual(["assert", "refine"]);
  });

  it("returns only the sets it changed", () => {
    const many = [set("built-in", [asserts("a", "one"), asserts("b", "two")]), set("provider", [asserts("c", "three")])];
    const proposed = resolve(e, many);
    expect(proposed.map((s) => s.setId)).toEqual(["built-in"]);
  });

  it("proposes nothing when nothing conflicts", () => {
    expect(resolve(evidence(), sets)).toEqual([]);
  });
});

describe("what it refuses to touch", () => {
  it("leaves an authored set alone, however badly it conflicts", () => {
    // A person may edit their own rules. A proposal is by definition not a
    // person, and these are the only rules that cannot be rebuilt.
    const household = [set("household", [asserts("a", "one"), asserts("b", "two")], true)];
    const e = evidence({
      conflicts: [{ setId: "household", categories: ["one", "two"], rules: [0, 1], transactions: 9, example: "X" }],
      reach: [reach("household", 0, 900, 30), reach("household", 1, 9, 1)],
    });
    expect(resolve(e, household)).toEqual([]);
  });

  it("ignores a conflict in a set it was not given", () => {
    const e = evidence({
      conflicts: [{ setId: "vanished", categories: ["a", "b"], rules: [0, 1], transactions: 1, example: "X" }],
      reach: [],
    });
    expect(resolve(e, [set("built-in", [asserts("a", "one")])])).toEqual([]);
  });

  it("leaves a rule that is already a refine as it is", () => {
    const withRefine = [
      set("built-in", [
        asserts("a", "one"),
        { matcher: { kind: "merchant", pattern: "b" }, contributes: { kind: "refine", category: "two" }, appliesTo: "debits" },
      ]),
    ];
    const e = evidence({
      conflicts: [{ setId: "built-in", categories: ["one", "two"], rules: [0, 1], transactions: 2, example: "X" }],
      reach: [reach("built-in", 0, 900, 30), reach("built-in", 1, 2, 1)],
    });
    const [proposed] = resolve(e, withRefine);
    expect(proposed?.rules[1]?.contributes).toEqual({ kind: "refine", category: "two" });
  });
});

describe("behind the port", () => {
  it("attributes what it proposes", async () => {
    // An accepted proposal records what proposed it. "a proposer" is not
    // specific enough to reproduce or to argue with later.
    const proposer = conflictResolver();
    expect(proposer.proposedBy).toBe("conflict-resolver");
    expect(await proposer.propose(evidence(), [])).toEqual([]);
  });
});
