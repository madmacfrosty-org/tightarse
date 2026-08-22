import { describe, it, expect } from "vitest";
import { noProposals, optimise } from "../src/application/optimise.js";
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
