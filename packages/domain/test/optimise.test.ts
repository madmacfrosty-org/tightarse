import { describe, it, expect } from "vitest";
import { decide, mayApproveAutomatically, noProposals, optimise, propose } from "../src/application/optimise.js";
import type { Evidence } from "../src/categorisation/evidence.js";
import type { OptimiseReport } from "../src/application/optimise.js";
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
  status: "effective",
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

describe("recording a proposal", () => {
  const NOW = new Date("2026-03-01T09:00:00.000Z");

  const catalogue = [
    { id: "one", label: "One", kind: "spending", taxonomy: "household", retired: false },
    { id: "gone", label: "Gone", kind: "spending", taxonomy: "household", retired: true },
  ] as unknown as Row[];

  function ruleSets(existing: RuleSet[], categories: Row[] = catalogue) {
    const written: RuleSet[] = [];
    const decisions: unknown[] = [];
    return {
      written,
      decisions,
      deps: {
        ruleSets: {
          listRuleSets: async () => existing as unknown as Row[],
          putRuleSetVersion: async (_t: string, s: RuleSet) => {
            written.push(s);
          },
          decideRuleSetVersion: async (...a: unknown[]) => {
            decisions.push(a);
          },
        },
        categories: { listCategories: async () => categories },
      } as never,
    };
  }

  it("writes the next version, marked proposed", async () => {
    // Readable and reviewable without changing what the fold does, or reviewing
    // it would be decoration.
    const existing = { ...set("built-in", [asserts("a", "one")]), version: 7 };
    const { deps, written } = ruleSets([existing]);
    const out = await propose(deps, "frost", [{ ...existing, version: 1 }], { now: NOW, by: "test" });
    expect(written[0]).toMatchObject({ version: 8, status: "proposed" });
    expect(out[0]).toEqual({ setId: "built-in", version: 8, rules: 1 });
  });

  it("assigns the version rather than trusting the proposal", async () => {
    // A proposer knows what the rules should be. It has no business deciding
    // where they sit in a history it cannot see.
    const { deps, written } = ruleSets([]);
    await propose(deps, "frost", [{ ...set("assisted", [asserts("a", "one")]), version: 99 }], { now: NOW, by: "t" });
    expect(written[0]?.version).toBe(1);
  });

  it("records who proposed it and when", async () => {
    const { deps, written } = ruleSets([]);
    await propose(deps, "frost", [set("built-in", [])], { now: NOW, by: "conflict-resolver" });
    expect(written[0]).toMatchObject({ createdBy: "conflict-resolver", createdAt: NOW.toISOString() });
  });

  it("proposes over an authored set, because a person may want that", async () => {
    // A derived proposal simplifying three rules into one can legitimately make
    // a hand-written special case redundant. Refusing to propose it means never
    // being offered it; the decision is the person's, at approval.
    const household = { ...set("household", [asserts("a", "one")]), authored: true };
    const { deps, written } = ruleSets([household]);
    await propose(deps, "frost", [household], { now: NOW, by: "conflict-resolver" });
    expect(written).toHaveLength(1);
  });

  it("refuses a rule naming a category that does not exist", async () => {
    const { deps, written } = ruleSets([]);
    await expect(
      propose(deps, "frost", [set("built-in", [asserts("a", "invented")])], { now: NOW, by: "t" }),
    ).rejects.toThrow(/invented/);
    expect(written).toEqual([]);
  });

  it("refuses a rule choosing a retired category", async () => {
    const { deps, written } = ruleSets([]);
    await expect(
      propose(deps, "frost", [set("built-in", [asserts("a", "gone")])], { now: NOW, by: "t" }),
    ).rejects.toThrow(/gone/);
    expect(written).toEqual([]);
  });

  it("checks every set before writing any, so a bad one fails the lot", async () => {
    const { deps, written } = ruleSets([]);
    await expect(
      propose(deps, "frost", [set("a", [asserts("x", "one")]), set("b", [asserts("y", "invented")])], {
        now: NOW,
        by: "t",
      }),
    ).rejects.toThrow();
    expect(written).toEqual([]);
  });
});

describe("deciding a proposal", () => {
  const NOW = new Date("2026-03-01T09:00:00.000Z");

  function ruleSets() {
    const decisions: unknown[][] = [];
    return {
      decisions,
      deps: {
        ruleSets: {
          listRuleSets: async () => [],
          putRuleSetVersion: async () => {},
          decideRuleSetVersion: async (...a: unknown[]) => {
            decisions.push(a);
          },
        },
      } as never,
    };
  }

  it("accepts, which publishes the version", async () => {
    const { deps, decisions } = ruleSets();
    const out = await decide(deps, "frost", [{ setId: "built-in", version: 8 }], { status: "effective" });
    expect(decisions[0]).toEqual(["frost", "built-in", 8, { status: "effective" }]);
    expect(out[0]).toEqual({ setId: "built-in", version: 8, status: "effective" });
  });

  it("rejects with a reason, because a declined proposal that leaves no trace is made again", async () => {
    const { deps, decisions } = ruleSets();
    await decide(deps, "frost", [{ setId: "built-in", version: 8 }], {
      status: "rejected",
      because: "loses 139 merchants",
    });
    expect(decisions[0]?.[3]).toEqual({ status: "rejected", because: "loses 139 merchants" });
  });

  it("decides every proposal it is given", async () => {
    const { deps, decisions } = ruleSets();
    await decide(
      deps,
      "frost",
      [
        { setId: "a", version: 1 },
        { setId: "b", version: 2 },
      ],
      { status: "effective" },
    );
    expect(decisions).toHaveLength(2);
  });

  it("does not touch a transaction — applying is categorise, separately", async () => {
    // A rule change and its effect on the ledger are different decisions, and
    // the second is re-runnable.
    const { deps, decisions } = ruleSets();
    await decide(deps, "frost", [{ setId: "a", version: 1 }], { status: "effective" });
    expect(decisions.every((d) => d[0] === "frost")).toBe(true);
  });
});

describe("whether a proposal may be approved without a person", () => {
  const better = {
    conflicts: { before: 4, after: 0 },
    inertRefines: { before: 0, after: 0 },
    gaps: { before: 100, after: 100 },
    deadRules: { before: 2, after: 2 },
  };
  const report = (over: Partial<OptimiseReport> = {}): OptimiseReport => ({
    scanned: 10,
    before: { reach: [], conflicts: [], inertRefines: [], gaps: [], scanned: 10 },
    proposed: [set("built-in", [])],
    proposedBy: "conflict-resolver",
    improvement: better,
    ...over,
  });

  it("allows a change that is unambiguously better", () => {
    expect(mayApproveAutomatically(report(), new Map())).toMatchObject({ allowed: true });
  });

  it("never allows one that replaces an authored set", () => {
    // A person may approve exactly this. A machine may not.
    const current = new Map([["built-in", { ...set("built-in", []), authored: true }]]);
    const v = mayApproveAutomatically(report(), current);
    expect(v.allowed).toBe(false);
    expect(v.because).toMatch(/authored/);
  });

  it("refuses one that loses coverage", () => {
    const v = mayApproveAutomatically(
      report({ improvement: { ...better, gaps: { before: 100, after: 239 } } }),
      new Map(),
    );
    expect(v.allowed).toBe(false);
    expect(v.because).toMatch(/139 more merchants/);
  });

  it("refuses one that adds conflicts", () => {
    const v = mayApproveAutomatically(
      report({ improvement: { ...better, conflicts: { before: 0, after: 3 } } }),
      new Map(),
    );
    expect(v.allowed).toBe(false);
    expect(v.because).toMatch(/3 more conflicts/);
  });

  it("refuses one that adds inert refines", () => {
    const v = mayApproveAutomatically(
      report({ improvement: { ...better, inertRefines: { before: 0, after: 2 } } }),
      new Map(),
    );
    expect(v.allowed).toBe(false);
  });

  it("refuses when nothing was proposed", () => {
    const v = mayApproveAutomatically(report({ improvement: undefined }), new Map());
    expect(v.allowed).toBe(false);
    expect(v.because).toMatch(/nothing was proposed/);
  });
});
