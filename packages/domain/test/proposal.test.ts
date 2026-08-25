import { describe, it, expect, vi } from "vitest";
import { proposeRules } from "../src/application/proposal.js";
import type { ProposalDeps } from "../src/application/proposal.js";
import type { RuleSet } from "../src/categorisation/rules.js";
import type { Row } from "../src/ports/outbound/index.js";

/**
 * Proposing a rule change, and saying what it would do.
 *
 * The two halves are one use case so they cannot drift: a dry run is the real
 * thing with the write skipped. What matters here is that the prediction is
 * computed rather than believed, that a dry run leaves nothing behind, and that
 * a proposal is written as `proposed` and never as effective.
 *
 * Merchants here are invented. Real ones are household data and do not go in
 * files.
 */

const RANGE = { from: "2026-01-01", to: "2026-12-31" };
const NOW = new Date("2026-08-25T12:00:00.000Z");

const tx = (description: string, amount = -10_00): Row => ({
  dedupKey: `d-${description}`,
  description,
  amount,
  currency: "GBP",
  timestamp: "2026-01-05T00:00:00.000Z",
});

const currentSet: Row = {
  setId: "household",
  version: 3,
  name: "household",
  order: 0,
  authored: true,
  status: "effective",
  createdAt: "2026-01-01T00:00:00.000Z",
  rules: [],
};

const proposedSet = (category = "groceries"): RuleSet =>
  ({
    setId: "household",
    version: 3,
    name: "household",
    order: 0,
    authored: true,
    status: "effective",
    createdAt: "2026-01-01T00:00:00.000Z",
    rules: [
      {
        matcher: { kind: "merchant", pattern: "somemart" },
        contributes: { kind: "assert", category },
        appliesTo: "debits",
      },
    ],
  }) as RuleSet;

const deps = (over: { transactions?: Row[]; sets?: Row[]; categories?: Row[] } = {}) => {
  const written: RuleSet[] = [];
  const decided: Array<{ setId: string; version: number; status: string }> = [];
  const applied: Array<Record<string, unknown>> = [];
  const d: ProposalDeps & {
    written: RuleSet[];
    decided: typeof decided;
    applied: typeof applied;
  } = {
    written,
    decided,
    applied,
    transactions: {
      listRange: vi.fn(async () => ({ transactions: over.transactions ?? [tx("SOMEMART 118")], categorisations: [] as Row[] })),
    } as unknown as ProposalDeps["transactions"],
    ruleSets: {
      // Accepting points `current` at the new version, so a run after it sees
      // the accepted rules. A fake that kept returning the old ones would let
      // "applying does nothing" pass as success.
      listRuleSets: vi.fn(async () => {
        const base = over.sets ?? [currentSet];
        const effective = written.filter((w) => decided.some((x) => x.setId === w.setId && x.version === w.version && x.status === "effective"));
        return effective.length === 0
          ? base
          : [...base.filter((b) => !effective.some((e) => e.setId === b["setId"])), ...effective.map((e) => ({ ...e, status: "effective" }))];
      }),
      putRuleSetVersion: vi.fn(async (_t: string, set: RuleSet) => {
        written.push(set);
      }),
      decideRuleSetVersion: vi.fn(async (_t: string, setId: string, version: number, d: { status: string }) => {
        decided.push({ setId, version, status: d.status });
      }),
    } as unknown as ProposalDeps["ruleSets"],
    categorisations: {
      putCategorisation: vi.fn(async (_t: string, c: Record<string, unknown>) => {
        applied.push(c);
      }),
      listCategorisationHistory: vi.fn(async () => [] as Row[]),
    } as unknown as ProposalDeps["categorisations"],
    categories: {
      listCategories: vi.fn(async () => over.categories ?? [{ id: "groceries", label: "Groceries", kind: "spending", retired: false }]),
    } as unknown as ProposalDeps["categories"],
  };
  return d;
};

describe("a preview", () => {
  it("says what the change would do", async () => {
    const d = deps();
    const out = await proposeRules(d, "frost", { sets: [proposedSet()], commit: "preview", by: "me", now: NOW, range: RANGE });

    expect(out.prediction.gained.transactions).toBe(1);
    expect(out.prediction.gained.entries[0]).toMatchObject({ to: "groceries" });
  });

  it("writes nothing at all", async () => {
    const d = deps();
    await proposeRules(d, "frost", { sets: [proposedSet()], commit: "preview", by: "me", now: NOW, range: RANGE });

    expect(d.ruleSets.putRuleSetVersion).not.toHaveBeenCalled();
    expect(d.written).toEqual([]);
    expect(d.decided).toEqual([]);
    expect(d.applied).toEqual([]);
  });

  it("reports no versions, because it created none", async () => {
    const d = deps();
    const out = await proposeRules(d, "frost", { sets: [proposedSet()], commit: "preview", by: "me", now: NOW, range: RANGE });

    expect(out.proposed).toBeUndefined();
  });

  it("still refuses a category that does not exist", async () => {
    // A caller asking what a change would do deserves to be told the change is
    // unwritable, rather than finding out when they mean it.
    const d = deps();
    await expect(
      proposeRules(d, "frost", { sets: [proposedSet("invented")], commit: "preview", by: "me", now: NOW, range: RANGE }),
    ).rejects.toThrow(/do not exist or are retired/);
  });
});

describe("proposing without deciding", () => {
  it("writes the version and stops there", async () => {
    // For a proposer that may not decide its own work. Nothing reaches a
    // transaction, and `current` still points at the version before it.
    const d = deps();
    const out = await proposeRules(d, "frost", { sets: [proposedSet()], commit: "propose", by: "me", now: NOW, range: RANGE });

    expect(d.written[0]).toMatchObject({ setId: "household", version: 4, status: "proposed" });
    expect(d.decided).toEqual([]);
    expect(d.applied).toEqual([]);
    expect(out.applied).toBeUndefined();
  });

  it("reports what it wrote, so a caller can come back and decide it", async () => {
    const out = await proposeRules(deps(), "frost", { sets: [proposedSet()], commit: "propose", by: "me", now: NOW, range: RANGE });

    expect(out.proposed).toEqual([{ setId: "household", version: 4, rules: 1 }]);
  });
});

describe("applying", () => {
  it("writes the next version, marked proposed and not effective", async () => {
    const d = deps();
    const out = await proposeRules(d, "frost", { sets: [proposedSet()], commit: "apply", by: "me", now: NOW, range: RANGE });

    expect(d.written).toHaveLength(1);
    expect(d.written[0]).toMatchObject({ setId: "household", version: 4, status: "proposed", createdBy: "me" });
    expect(out.proposed).toEqual([{ setId: "household", version: 4, rules: 1 }]);
  });

  it("predicts the same thing the dry run did", async () => {
    const dry = await proposeRules(deps(), "frost", { sets: [proposedSet()], commit: "preview", by: "me", now: NOW, range: RANGE });
    const real = await proposeRules(deps(), "frost", { sets: [proposedSet()], commit: "apply", by: "me", now: NOW, range: RANGE });

    expect(real.prediction).toEqual(dry.prediction);
  });

  it("writes nothing when a category is unknown, rather than half the sets", async () => {
    const d = deps();
    await expect(
      proposeRules(d, "frost", { sets: [proposedSet("invented")], commit: "apply", by: "me", now: NOW, range: RANGE }),
    ).rejects.toThrow();
    expect(d.written).toEqual([]);
  });

  it("accepts what it wrote, so the version becomes the one in force", async () => {
    const d = deps();
    await proposeRules(d, "frost", { sets: [proposedSet()], commit: "apply", by: "me", now: NOW, range: RANGE });

    expect(d.decided).toEqual([{ setId: "household", version: 4, status: "effective" }]);
  });

  it("recategorises, because accepting a rule reaches no transaction on its own", async () => {
    const d = deps();
    const out = await proposeRules(d, "frost", { sets: [proposedSet()], commit: "apply", by: "me", now: NOW, range: RANGE });

    expect(out.applied).toBeDefined();
    expect(out.applied!.scanned).toBe(1);
    expect(out.applied!.appended).toBe(1);
  });

  it("applies over the range it measured, so the prediction describes what happened", async () => {
    // A prediction measured over one span and applied over another describes
    // something that did not happen, and the comparison stops meaning anything.
    const d = deps();
    const out = await proposeRules(d, "frost", { sets: [proposedSet()], commit: "apply", by: "me", now: NOW, range: RANGE });

    expect(out.applied!.scanned).toBe(out.prediction.scanned);
  });

  it("stamps the time it was proposed", async () => {
    const d = deps();
    await proposeRules(d, "frost", { sets: [proposedSet()], commit: "apply", by: "me", now: NOW, range: RANGE });

    expect(d.written[0]!.createdAt).toBe("2026-08-25T12:00:00.000Z");
  });
});

describe("building the rule from what was asked for", () => {
  it("turns a term into a household rule, escaped", async () => {
    // The term, not a pattern. A client that escaped it would be a second
    // implementation of what decides which transactions a rule takes.
    const d = deps({ transactions: [tx("PIZZA (EXPRESS) 42")] });
    await proposeRules(d, "frost", {
      merchant: { term: "PIZZA (EXPRESS)", category: "groceries" },
      commit: "apply",
      by: "me",
      now: NOW,
      range: RANGE,
    });

    expect(d.written[0]).toMatchObject({ setId: "household", order: 0, authored: true });
    expect(d.written[0]!.rules.at(-1)).toMatchObject({
      matcher: { kind: "merchant", pattern: String.raw`PIZZA \(EXPRESS\) ` .trim() },
      contributes: { kind: "assert", category: "groceries" },
      appliesTo: "debits",
    });
  });

  it("keeps the rules a set already had, and adds to the end", async () => {
    // Order within a set is data. A rule that quietly went first would change
    // what the existing ones do.
    const existing = { ...currentSet, rules: [
      { matcher: { kind: "merchant", pattern: "othershop" }, contributes: { kind: "assert", category: "groceries" }, appliesTo: "debits" },
    ] };
    const d = deps({ sets: [existing] });
    await proposeRules(d, "frost", {
      merchant: { term: "somemart", category: "groceries" },
      commit: "apply", by: "me", now: NOW, range: RANGE,
    });

    expect(d.written[0]!.rules).toHaveLength(2);
    expect(d.written[0]!.rules[0]).toMatchObject({ matcher: { pattern: "othershop" } });
  });

  it("names transactions outright at override precedence, one rule each", async () => {
    const d = deps();
    await proposeRules(d, "frost", {
      transactions: { dedupKeys: ["a", "b"], category: "groceries" },
      commit: "apply", by: "me", now: NOW, range: RANGE,
    });

    expect(d.written[0]).toMatchObject({ setId: "overrides", order: -1 });
    expect(d.written[0]!.rules).toEqual([
      { matcher: { kind: "transaction", dedupKey: "a" }, contributes: { kind: "assert", category: "groceries" }, appliesTo: "all" },
      { matcher: { kind: "transaction", dedupKey: "b" }, contributes: { kind: "assert", category: "groceries" }, appliesTo: "all" },
    ]);
  });

  it("categorises a credit named outright, which a debits rule would decline", async () => {
    // A direction gate on top of a named transaction could refuse the very row
    // that was asked for, which is why these rules apply to everything.
    const d = deps({ transactions: [tx("REFUND", 25_00)] });
    const out = await proposeRules(d, "frost", {
      transactions: { dedupKeys: ["d-REFUND"], category: "groceries" },
      commit: "preview", by: "me", now: NOW, range: RANGE,
    });

    expect(out.prediction.gained.transactions).toBe(1);
    expect(out.prediction.gained.entries[0]).toMatchObject({ to: "groceries" });
  });

  it("refuses a proposal that says nothing", async () => {
    await expect(
      proposeRules(deps(), "frost", { commit: "preview", by: "me", now: NOW, range: RANGE }),
    ).rejects.toThrow(/sets, a merchant, or transactions/);
  });

  it("checks a merchant category exists, same as any other", async () => {
    await expect(
      proposeRules(deps(), "frost", {
        merchant: { term: "somemart", category: "invented" },
        commit: "preview", by: "me", now: NOW, range: RANGE,
      }),
    ).rejects.toThrow(/do not exist or are retired/);
  });
});

describe("what the prediction is measured against", () => {
  it("advances the version, or the change would preview as touching nothing", async () => {
    // `preview` identifies what changed by version. A proposal carrying the
    // version it already has previews as an empty result — which reads as a
    // harmless change rather than a broken measurement.
    const out = await proposeRules(deps(), "frost", { sets: [proposedSet()], commit: "preview", by: "me", now: NOW, range: RANGE });

    expect(out.prediction.gained.transactions).toBeGreaterThan(0);
  });

  it("starts a set that does not exist yet at version one", async () => {
    // Proposing the overrides set for the first time, or any set a tenant has
    // never had. Nothing to advance from, so it begins rather than fails.
    const d = deps();
    const brandNew = { ...proposedSet(), setId: "overrides", name: "overrides", order: -1 } as typeof currentSet & RuleSet;
    const out = await proposeRules(d, "frost", { sets: [brandNew], commit: "apply", by: "me", now: NOW, range: RANGE });

    expect(out.proposed).toEqual([{ setId: "overrides", version: 1, rules: 1 }]);
    expect(d.written[0]).toMatchObject({ setId: "overrides", version: 1, status: "proposed" });
  });

  it("measures against the range it was given", async () => {
    const d = deps();
    await proposeRules(d, "frost", { sets: [proposedSet()], commit: "preview", by: "me", now: NOW, range: RANGE });

    expect(d.transactions.listRange).toHaveBeenCalledWith("frost", RANGE);
  });

  it("skips a stored set it cannot read rather than refusing to predict", async () => {
    const d = deps({ sets: [{ setId: "broken" }, currentSet] });
    const out = await proposeRules(d, "frost", { sets: [proposedSet()], commit: "preview", by: "me", now: NOW, range: RANGE });

    expect(out.prediction.gained.transactions).toBe(1);
  });

  it("reports what the proposal leaves alone", async () => {
    const d = deps({ transactions: [tx("SOMEMART 118"), tx("SOMETHING ELSE")] });
    const out = await proposeRules(d, "frost", { sets: [proposedSet()], commit: "preview", by: "me", now: NOW, range: RANGE });

    expect(out.prediction.scanned).toBe(2);
    expect(out.prediction.gained.transactions).toBe(1);
  });
});
