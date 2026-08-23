import { describe, it, expect } from "vitest";
import { accept, noProposals, optimise } from "../src/application/optimise.js";
import type { Evidence } from "../src/categorisation/evidence.js";
import type { Rule, RuleSet } from "../src/categorisation/rules.js";
import type { Row, RuleProposer } from "../src/ports/outbound/index.js";

/**
 * Improving the rules.
 *
 * One use case behind a port, so a deterministic pass, a person and a model are
 * the same operation with different opinions. What matters here is that it
 * measures both sides against the same ledger and writes nothing.
 */

const RANGE = { from: "2026-01-01", to: "2026-03-01" };

const asserts = (pattern: string, category: string): Rule => ({
  matcher: { kind: "merchant", pattern },
  contributes: { kind: "assert", category },
  appliesTo: "debits",
});

const set = (setId: string, rules: Rule[], order = 2): RuleSet => ({
  setId,
  version: 1,
  name: setId,
  order,
  authored: false,
  rules,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const row = (description: string): Row => ({
  dedupKey: `d-${description}`,
  description,
  amount: -10_00,
  currency: "GBP",
  timestamp: "2026-02-01T00:00:00.000Z",
});

function deps(sets: RuleSet[], rows: Row[], proposer: RuleProposer = noProposals) {
  return {
    transactions: { listRange: async () => ({ transactions: rows, enrichments: [], categorisations: [] }) },
    ruleSets: { listRuleSets: async () => sets as unknown as Row[] },
    proposer,
  } as never;
}

const conflicted = set("built-in", [asserts("somemart", "groceries"), asserts("store", "shopping")]);
const fixed = set("built-in", [asserts("somemart", "groceries")]);

describe("with nothing proposed", () => {
  it("reports what the rules do and proposes nothing", async () => {
    const report = await optimise(deps([conflicted], [row("SOMEMART STORE")]), "frost", { range: RANGE });
    expect(report.proposed).toEqual([]);
    expect(report.proposedBy).toBe("none");
    expect(report.before.conflicts).toHaveLength(1);
  });

  it("offers no comparison, because there is nothing to compare with", async () => {
    const report = await optimise(deps([conflicted], [row("SOMEMART STORE")]), "frost", { range: RANGE });
    expect(report.after).toBeUndefined();
    expect(report.improvement).toBeUndefined();
  });

  it("is the plain diagnostic, on the same path as everything else", async () => {
    // The default proposing nothing is what lets "what is wrong with my rules"
    // be an implementation rather than a branch.
    const report = await optimise(deps([conflicted], [row("SOMEMART STORE")]), "frost", { range: RANGE });
    expect(report.before.conflicts[0]).toMatchObject({ rules: [0, 1], transactions: 1 });
  });
});

describe("with something proposed", () => {
  const proposer = (sets: RuleSet[]): RuleProposer => ({
    proposedBy: "test-proposer",
    propose: async () => sets,
  });

  it("measures the proposal against the same ledger, and says whether it is better", async () => {
    const report = await optimise(
      deps([conflicted], [row("SOMEMART STORE")], proposer([fixed])),
      "frost",
      { range: RANGE },
    );
    expect(report.improvement?.conflicts).toEqual({ before: 1, after: 0 });
    expect(report.improvement?.inertRefines).toEqual({ before: 0, after: 0 });
    expect(report.proposedBy).toBe("test-proposer");
  });

  it("shows a proposal making things worse just as plainly", async () => {
    // A report that only reads well when the news is good is not a report.
    const report = await optimise(
      deps([fixed], [row("SOMEMART STORE")], proposer([conflicted])),
      "frost",
      { range: RANGE },
    );
    expect(report.improvement?.conflicts).toEqual({ before: 0, after: 1 });
  });

  it("counts rules that would match nothing, before and after", async () => {
    const withDeadRule = set("built-in", [asserts("somemart", "groceries"), asserts("nowhere", "shopping")]);
    const report = await optimise(
      deps([fixed], [row("SOMEMART STORE")], proposer([withDeadRule])),
      "frost",
      { range: RANGE },
    );
    expect(report.improvement?.deadRules).toEqual({ before: 0, after: 1 });
  });

  it("counts coverage as merchants nothing matches", async () => {
    const report = await optimise(
      deps([fixed], [row("SOMEMART"), row("UNKNOWN")], proposer([set("built-in", [asserts("unknown", "shopping")])])),
      "frost",
      { range: RANGE },
    );
    // Before: UNKNOWN uncovered. After: SOMEMART uncovered instead. One each.
    expect(report.improvement?.gaps).toEqual({ before: 1, after: 1 });
  });

  it("writes nothing, whatever was proposed", async () => {
    // Accepting is a separate, deliberate act: a rule change alters what every
    // matching transaction says, and under re-application changes history too.
    const writes: unknown[] = [];
    const d = {
      transactions: { listRange: async () => ({ transactions: [row("SOMEMART STORE")], enrichments: [], categorisations: [] }) },
      ruleSets: {
        listRuleSets: async () => [conflicted] as unknown as Row[],
        putRuleSetVersion: async (...a: unknown[]) => {
          writes.push(a);
        },
      },
      proposer: proposer([fixed]),
    } as never;
    await optimise(d, "frost", { range: RANGE });
    expect(writes).toEqual([]);
  });

  it("gives the proposer the evidence, not the raw ledger", async () => {
    // A proposer reasons about what the rules do. Handing it the transactions
    // would let it classify them directly, which is the thing the design
    // forbids.
    let seen: Evidence | undefined;
    const spy: RuleProposer = {
      proposedBy: "spy",
      propose: async (evidence) => {
        seen = evidence;
        return [];
      },
    };
    await optimise(deps([conflicted], [row("SOMEMART STORE")], spy), "frost", { range: RANGE });
    expect(seen?.conflicts).toHaveLength(1);
    expect(seen?.scanned).toBe(1);
  });
});

describe("accepting a proposal", () => {
  const NOW = new Date("2026-03-01T09:00:00.000Z");

  const catalogue = [
    { id: "one", label: "One", kind: "spending", taxonomy: "household", retired: false },
    { id: "gone", label: "Gone", kind: "spending", taxonomy: "household", retired: true },
  ] as unknown as Row[];

  function ruleSets(existing: RuleSet[], categories: Row[] = catalogue) {
    const written: RuleSet[] = [];
    return {
      written,
      deps: {
        ruleSets: {
          listRuleSets: async () => existing as unknown as Row[],
          putRuleSetVersion: async (_t: string, s: RuleSet) => {
            written.push(s);
          },
        },
        categories: { listCategories: async () => categories },
      } as never,
    };
  }

  it("publishes the next version, rather than the one it was handed", async () => {
    // A proposer knows what the rules should be. It has no business deciding
    // where they sit in a history it cannot see.
    const existing = { ...set("built-in", [asserts("a", "one")]), version: 7 };
    const { deps, written } = ruleSets([existing]);
    const result = await accept(deps, "frost", [{ ...existing, version: 1 }], { now: NOW, by: "test" });
    expect(written[0]?.version).toBe(8);
    expect(result[0]).toEqual({ setId: "built-in", from: 7, to: 8, rules: 1 });
  });

  it("starts at version one for a set that does not exist yet", async () => {
    const { deps, written } = ruleSets([]);
    await accept(deps, "frost", [set("assisted", [asserts("a", "one")])], { now: NOW, by: "test" });
    expect(written[0]?.version).toBe(1);
  });

  it("records who accepted it and when", async () => {
    const { deps, written } = ruleSets([]);
    await accept(deps, "frost", [set("built-in", [])], { now: NOW, by: "conflict-resolver" });
    expect(written[0]).toMatchObject({ createdBy: "conflict-resolver", createdAt: NOW.toISOString() });
  });

  it("refuses a rule naming a category that does not exist", async () => {
    // Rules are data, so a category id is something a person typed or a model
    // produced. Unchecked it is a rule that matches happily and then asserts
    // something nothing can resolve.
    const { deps, written } = ruleSets([]);
    await expect(
      accept(deps, "frost", [set("built-in", [asserts("a", "invented")])], { now: NOW, by: "test" }),
    ).rejects.toThrow(/invented/);
    expect(written).toEqual([]);
  });

  it("refuses a rule choosing a retired category", async () => {
    // A retired category still resolves for rows already pointing at it — that
    // is why categories are never deleted — but a NEW rule choosing one is
    // reaching for something deliberately withdrawn.
    const { deps, written } = ruleSets([]);
    await expect(
      accept(deps, "frost", [set("built-in", [asserts("a", "gone")])], { now: NOW, by: "test" }),
    ).rejects.toThrow(/gone/);
    expect(written).toEqual([]);
  });

  it("checks every set before writing any, so a bad one fails the lot", async () => {
    const { deps, written } = ruleSets([]);
    await expect(
      accept(
        deps,
        "frost",
        [set("a", [asserts("x", "one")]), set("b", [asserts("y", "invented")])],
        { now: NOW, by: "test" },
      ),
    ).rejects.toThrow();
    expect(written).toEqual([]);
  });

  it("needs no catalogue when a proposal has no rules to check", async () => {
    const { deps, written } = ruleSets([], []);
    await accept(deps, "frost", [set("built-in", [])], { now: NOW, by: "test" });
    expect(written).toHaveLength(1);
  });

  it("refuses to replace an authored set, and writes nothing at all", async () => {
    // Custody enforced rather than remembered. "Improve the rules" must not be
    // an operation capable of destroying the only data that cannot be rebuilt.
    const household = { ...set("household", [asserts("a", "one")]), authored: true };
    const { deps, written } = ruleSets([household]);
    await expect(accept(deps, "frost", [household], { now: NOW, by: "test" })).rejects.toThrow(/authored/);
    expect(written).toEqual([]);
  });
});
