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
  const d: ProposalDeps & { written: RuleSet[] } = {
    written,
    transactions: {
      listRange: vi.fn(async () => ({ transactions: over.transactions ?? [tx("SOMEMART 118")], categorisations: [] as Row[] })),
    } as unknown as ProposalDeps["transactions"],
    ruleSets: {
      listRuleSets: vi.fn(async () => over.sets ?? [currentSet]),
      putRuleSetVersion: vi.fn(async (_t: string, set: RuleSet) => {
        written.push(set);
      }),
    } as unknown as ProposalDeps["ruleSets"],
    categories: {
      listCategories: vi.fn(async () => over.categories ?? [{ id: "groceries", label: "Groceries", kind: "spending", retired: false }]),
    } as unknown as ProposalDeps["categories"],
  };
  return d;
};

describe("a dry run", () => {
  it("says what the change would do", async () => {
    const d = deps();
    const out = await proposeRules(d, "frost", { sets: [proposedSet()], dryRun: true, by: "me", now: NOW, range: RANGE });

    expect(out.prediction.gained.transactions).toBe(1);
    expect(out.prediction.gained.entries[0]).toMatchObject({ to: "groceries" });
  });

  it("writes nothing at all", async () => {
    const d = deps();
    await proposeRules(d, "frost", { sets: [proposedSet()], dryRun: true, by: "me", now: NOW, range: RANGE });

    expect(d.ruleSets.putRuleSetVersion).not.toHaveBeenCalled();
    expect(d.written).toEqual([]);
  });

  it("reports no versions, because it created none", async () => {
    const d = deps();
    const out = await proposeRules(d, "frost", { sets: [proposedSet()], dryRun: true, by: "me", now: NOW, range: RANGE });

    expect(out.proposed).toBeUndefined();
  });

  it("still refuses a category that does not exist", async () => {
    // A caller asking what a change would do deserves to be told the change is
    // unwritable, rather than finding out when they mean it.
    const d = deps();
    await expect(
      proposeRules(d, "frost", { sets: [proposedSet("invented")], dryRun: true, by: "me", now: NOW, range: RANGE }),
    ).rejects.toThrow(/do not exist or are retired/);
  });
});

describe("a real proposal", () => {
  it("writes the next version, marked proposed and not effective", async () => {
    const d = deps();
    const out = await proposeRules(d, "frost", { sets: [proposedSet()], dryRun: false, by: "me", now: NOW, range: RANGE });

    expect(d.written).toHaveLength(1);
    expect(d.written[0]).toMatchObject({ setId: "household", version: 4, status: "proposed", createdBy: "me" });
    expect(out.proposed).toEqual([{ setId: "household", version: 4, rules: 1 }]);
  });

  it("predicts the same thing the dry run did", async () => {
    const dry = await proposeRules(deps(), "frost", { sets: [proposedSet()], dryRun: true, by: "me", now: NOW, range: RANGE });
    const real = await proposeRules(deps(), "frost", { sets: [proposedSet()], dryRun: false, by: "me", now: NOW, range: RANGE });

    expect(real.prediction).toEqual(dry.prediction);
  });

  it("writes nothing when a category is unknown, rather than half the sets", async () => {
    const d = deps();
    await expect(
      proposeRules(d, "frost", { sets: [proposedSet("invented")], dryRun: false, by: "me", now: NOW, range: RANGE }),
    ).rejects.toThrow();
    expect(d.written).toEqual([]);
  });

  it("stamps the time it was proposed", async () => {
    const d = deps();
    await proposeRules(d, "frost", { sets: [proposedSet()], dryRun: false, by: "me", now: NOW, range: RANGE });

    expect(d.written[0]!.createdAt).toBe("2026-08-25T12:00:00.000Z");
  });
});

describe("what the prediction is measured against", () => {
  it("advances the version, or the change would preview as touching nothing", async () => {
    // `preview` identifies what changed by version. A proposal carrying the
    // version it already has previews as an empty result — which reads as a
    // harmless change rather than a broken measurement.
    const out = await proposeRules(deps(), "frost", { sets: [proposedSet()], dryRun: true, by: "me", now: NOW, range: RANGE });

    expect(out.prediction.gained.transactions).toBeGreaterThan(0);
  });

  it("starts a set that does not exist yet at version one", async () => {
    // Proposing the overrides set for the first time, or any set a tenant has
    // never had. Nothing to advance from, so it begins rather than fails.
    const d = deps();
    const brandNew = { ...proposedSet(), setId: "overrides", name: "overrides", order: -1 } as typeof currentSet & RuleSet;
    const out = await proposeRules(d, "frost", { sets: [brandNew], dryRun: false, by: "me", now: NOW, range: RANGE });

    expect(out.proposed).toEqual([{ setId: "overrides", version: 1, rules: 1 }]);
    expect(d.written[0]).toMatchObject({ setId: "overrides", version: 1, status: "proposed" });
  });

  it("measures against the range it was given", async () => {
    const d = deps();
    await proposeRules(d, "frost", { sets: [proposedSet()], dryRun: true, by: "me", now: NOW, range: RANGE });

    expect(d.transactions.listRange).toHaveBeenCalledWith("frost", RANGE);
  });

  it("skips a stored set it cannot read rather than refusing to predict", async () => {
    const d = deps({ sets: [{ setId: "broken" }, currentSet] });
    const out = await proposeRules(d, "frost", { sets: [proposedSet()], dryRun: true, by: "me", now: NOW, range: RANGE });

    expect(out.prediction.gained.transactions).toBe(1);
  });

  it("reports what the proposal leaves alone", async () => {
    const d = deps({ transactions: [tx("SOMEMART 118"), tx("SOMETHING ELSE")] });
    const out = await proposeRules(d, "frost", { sets: [proposedSet()], dryRun: true, by: "me", now: NOW, range: RANGE });

    expect(out.prediction.scanned).toBe(2);
    expect(out.prediction.gained.transactions).toBe(1);
  });
});
