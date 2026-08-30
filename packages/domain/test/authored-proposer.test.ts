import { describe, it, expect } from "vitest";
import { editing, replacing } from "../src/categorisation/authored-proposer.js";
import type { Evidence, Rule, RuleSet } from "../src/index.js";

/**
 * Proposals from a person.
 *
 * The route that makes rules operational, so what matters is that a mistyped
 * edit fails loudly here rather than one transaction into a re-application.
 */

const evidence: Evidence = { reach: [], conflicts: [], inertRefines: [], gaps: [], scanned: 0 };

const rule = (pattern: string, category: string): Rule => ({
  matcher: { kind: "merchant", pattern },
  contributes: { kind: "assert", category },
  appliesTo: "debits",
});

const sets: RuleSet[] = [
  {
    setId: "built-in",
    version: 4,
    name: "built-in",
    order: 2,
    authored: false,
    status: "effective",
    rules: [rule("somemart", "groceries"), rule("MOTO |SHELL", "fuel")],
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

describe("changing one rule", () => {
  it("narrows a pattern and leaves everything else alone", async () => {
    // The operational fix this exists for: a pattern that matched motorway
    // services when it meant fuel.
    const [proposed] = await editing({ setId: "built-in", index: 1, pattern: "SHELL" }, "someone").propose(evidence, sets);
    expect(proposed?.rules[1]?.matcher).toEqual({ kind: "merchant", pattern: "SHELL" });
    expect(proposed?.rules[0]).toEqual(sets[0]?.rules[0]);
    expect(proposed?.version).toBe(4);
  });

  it("changes a category without touching the pattern", async () => {
    const [proposed] = await editing({ setId: "built-in", index: 0, category: "shopping" }, "someone").propose(evidence, sets);
    expect(proposed?.rules[0]?.contributes).toEqual({ kind: "assert", category: "shopping" });
    expect(proposed?.rules[0]?.matcher).toEqual({ kind: "merchant", pattern: "somemart" });
  });

  it("turns an assert into a refine, keeping its category", async () => {
    const [proposed] = await editing({ setId: "built-in", index: 1, contributes: "refine" }, "someone").propose(evidence, sets);
    expect(proposed?.rules[1]?.contributes).toEqual({ kind: "refine", category: "fuel" });
  });

  it("records who proposed it", async () => {
    // An accepted proposal names what proposed it, and "a person" is not enough
    // to ask about it later.
    expect(editing({ setId: "built-in", index: 0 }, "frost").proposedBy).toBe("authored:frost");
  });
});

describe("refusing a mistyped edit", () => {
  it("fails on a set that does not exist", async () => {
    await expect(editing({ setId: "nope", index: 0 }, "x").propose(evidence, sets)).rejects.toThrow(/No set/);
  });

  it("fails on a rule position the set does not have, and says how many it has", async () => {
    await expect(editing({ setId: "built-in", index: 9 }, "x").propose(evidence, sets)).rejects.toThrow(/it has 2/);
  });

  it("fails on a pattern that will not compile", async () => {
    // At the proposal rather than at the fold, where it would be one
    // transaction into re-applying the ledger.
    await expect(
      editing({ setId: "built-in", index: 1, pattern: "([unclosed" }, "x").propose(evidence, sets),
    ).rejects.toThrow();
  });

  it("fails when asked to change the pattern of a rule that has none", async () => {
    const byProvider: RuleSet[] = [
      {
        ...sets[0]!,
        rules: [{ matcher: { kind: "providerCategory", value: "ATM" }, contributes: { kind: "assert", category: "cash-withdrawal" }, appliesTo: "debits" }],
      },
    ];
    await expect(
      editing({ setId: "built-in", index: 0, pattern: "x" }, "x").propose(evidence, byProvider),
    ).rejects.toThrow(/no pattern to change/);
  });
});

describe("supplying whole sets", () => {
  it("passes them through, which is the shape a model will produce", async () => {
    const proposer = replacing(sets, "a-file");
    expect(await proposer.propose(evidence, [])).toEqual(sets);
    expect(proposer.proposedBy).toBe("authored:a-file");
  });
});
