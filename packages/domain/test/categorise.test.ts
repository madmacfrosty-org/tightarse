import { describe, it, expect } from "vitest";
import { categorise, decide } from "../src/application/categorise.js";
import type { Categorisation } from "../src/categorisation/categorisation.js";
import type { Evaluation } from "../src/categorisation/evaluate.js";
import type { Rule, RuleSet } from "../src/categorisation/rules.js";
import type { Row } from "../src/ports/outbound/index.js";

/**
 * Applying rule sets to the ledger.
 *
 * The properties that matter are not which category comes out — that is
 * evaluate's business — but what gets written: nothing when the answer has not
 * changed, never over an authored set, and the same thing twice when run twice.
 *
 * Merchants here are invented. Real ones are household data and do not go in
 * files.
 */

const NOW = new Date("2026-03-01T09:00:00.000Z");
const RANGE = { from: "2026-01-01", to: "2026-03-01" };

const evaluation = (category?: string, setId = "built-in", version = 1): Evaluation => ({
  ...(category === undefined ? {} : { effective: { setId, version, category } }),
  sets: [],
});

const stored = (over: Partial<Categorisation> = {}): Categorisation => ({
  dedupKey: "d1",
  timestamp: "2026-02-01T00:00:00.000Z",
  category: "groceries",
  setId: "built-in",
  setVersion: 1,
  version: 1,
  status: "effective",
  appliedAt: "2026-02-02T00:00:00.000Z",
  ...over,
});

const args = { authored: new Set<string>(), dedupKey: "d1", timestamp: "2026-02-01T00:00:00.000Z", now: NOW.toISOString() };

describe("what to do about one transaction", () => {
  it("writes nothing when the rules produce what is already stored", () => {
    // Write volume proportional to changes rather than to transactions is what
    // makes re-applying the whole ledger cheap enough to be the default.
    expect(decide({ ...args, evaluation: evaluation("groceries"), current: stored() })).toEqual({ kind: "unchanged" });
  });

  it("treats a different answer as a change and appends the next version", () => {
    const d = decide({ ...args, evaluation: evaluation("fuel"), current: stored({ version: 3 }) });
    expect(d.kind).toBe("append");
    if (d.kind !== "append") throw new Error("expected append");
    expect(d.next.version).toBe(4);
    expect(d.next.category).toBe("fuel");
    expect(d.next.status).toBe("effective");
    expect(d.next.appliedAt).toBe(NOW.toISOString());
  });

  it("starts at version one for a transaction with no categorisation", () => {
    const d = decide({ ...args, evaluation: evaluation("groceries") });
    if (d.kind !== "append") throw new Error("expected append");
    expect(d.next.version).toBe(1);
  });

  it("does not append merely because the provenance moved", () => {
    // A rule edit that bumps a set version without changing any answer would
    // otherwise rewrite every row in the ledger.
    const d = decide({
      ...args,
      evaluation: evaluation("groceries", "built-in", 9),
      current: stored({ setVersion: 2 }),
    });
    expect(d).toEqual({ kind: "unchanged" });
  });

  it("never regenerates over an authored set", () => {
    // Derived data overwriting authored data has already happened here, and
    // custody has to be structural rather than remembered.
    const d = decide({
      ...args,
      authored: new Set(["household"]),
      evaluation: evaluation("fuel"),
      current: stored({ setId: "household" }),
    });
    expect(d).toEqual({ kind: "protected", by: "household" });
  });

  it("surfaces a stored category that nothing matches any more, and leaves it alone", () => {
    // Silently keeping a category nobody can explain is worse than saying so,
    // and deleting it would lose the history.
    expect(decide({ ...args, evaluation: evaluation(undefined), current: stored() })).toEqual({
      kind: "orphaned",
      category: "groceries",
    });
  });

  it("says nothing for a transaction no rule matches, which is the backlog", () => {
    expect(decide({ ...args, evaluation: evaluation(undefined) })).toEqual({ kind: "none" });
  });
});

const rule = (pattern: string, category: string): Rule => ({
  matcher: { kind: "merchant", pattern },
  contributes: { kind: "assert", category },
  appliesTo: "debits",
});

const set = (over: Partial<RuleSet> & { setId: string; order: number; rules: Rule[] }): RuleSet => ({
  version: 1,
  name: over.setId,
  authored: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const txRow = (dedupKey: string, description: string): Row => ({
  dedupKey,
  description,
  amount: -12_00,
  currency: "GBP",
  timestamp: "2026-02-01T00:00:00.000Z",
});

function ledger(txns: Row[], cats: Row[] = [], sets: RuleSet[] = [set({ setId: "built-in", order: 2, rules: [rule("somemart", "groceries")] })]) {
  const written: Categorisation[] = [];
  return {
    written,
    deps: {
      transactions: {
        listRange: async () => ({ transactions: txns, enrichments: [], categorisations: cats }),
      },
      ruleSets: { listRuleSets: async () => sets as unknown as Row[] },
      categorisations: {
        putCategorisation: async (_t: string, c: Categorisation) => {
          written.push(c);
        },
      },
    } as never,
  };
}

describe("applying over a range", () => {
  it("writes a categorisation for what the rules place", async () => {
    const { deps, written } = ledger([txRow("d1", "SOMEMART SUPERSTORE")]);
    const report = await categorise(deps, "frost", { range: RANGE, now: NOW });
    expect(report).toMatchObject({ scanned: 1, appended: 1, unchanged: 0 });
    expect(written[0]).toMatchObject({ dedupKey: "d1", category: "groceries", version: 1 });
  });

  it("writes nothing the second time, because idempotency is load-bearing", async () => {
    // Applying the same set versions to the same transactions must give the
    // same answer, or every run appends and the history fills with churn.
    const first = ledger([txRow("d1", "SOMEMART SUPERSTORE")]);
    const report1 = await categorise(first.deps, "frost", { range: RANGE, now: NOW });
    expect(report1.appended).toBe(1);

    const asStored = first.written.map((c) => c as unknown as Row);
    const second = ledger([txRow("d1", "SOMEMART SUPERSTORE")], asStored);
    const report2 = await categorise(second.deps, "frost", { range: RANGE, now: NOW });
    expect(report2).toMatchObject({ appended: 0, unchanged: 1 });
    expect(second.written).toEqual([]);
  });

  it("counts a transaction nothing matches rather than writing one", async () => {
    const { deps, written } = ledger([txRow("d1", "UTTERLY UNKNOWN")]);
    const report = await categorise(deps, "frost", { range: RANGE, now: NOW });
    expect(report).toMatchObject({ scanned: 1, uncategorised: 1, appended: 0 });
    expect(written).toEqual([]);
  });

  it("leaves an authored categorisation alone", async () => {
    const authored = set({ setId: "household", order: 0, authored: true, rules: [] });
    const builtIn = set({ setId: "built-in", order: 2, rules: [rule("somemart", "fuel")] });
    const cat = { ...stored({ setId: "household", category: "gifts-charity" }) } as unknown as Row;
    const { deps, written } = ledger([txRow("d1", "SOMEMART SUPERSTORE")], [cat], [authored, builtIn]);
    const report = await categorise(deps, "frost", { range: RANGE, now: NOW });
    expect(report).toMatchObject({ protectedFromChange: 1, appended: 0 });
    expect(written).toEqual([]);
  });

  it("takes the highest version in force, not the last row a scan returned", async () => {
    // Versions sort adjacently, but a scan is not a promise of order.
    const cats = [
      stored({ version: 2, category: "fuel" }) as unknown as Row,
      stored({ version: 1, category: "groceries" }) as unknown as Row,
    ];
    const { deps } = ledger([txRow("d1", "SOMEMART SUPERSTORE")], cats);
    const report = await categorise(deps, "frost", { range: RANGE, now: NOW });
    // Stored is fuel at v2; the rules say groceries, so this is a change.
    expect(report).toMatchObject({ appended: 1, unchanged: 0 });
  });

  it("ignores a proposed version, which must not change what anything reads", async () => {
    const cats = [stored({ version: 2, category: "fuel", status: "proposed" }) as unknown as Row];
    const { deps } = ledger([txRow("d1", "SOMEMART SUPERSTORE")], cats);
    const report = await categorise(deps, "frost", { range: RANGE, now: NOW });
    expect(report).toMatchObject({ appended: 1 });
  });

  it("counts conflicts and inert refines without inventing an answer", async () => {
    const conflicted = set({
      setId: "built-in",
      order: 2,
      rules: [rule("somemart", "groceries"), rule("superstore", "shopping")],
    });
    const { deps, written } = ledger([txRow("d1", "SOMEMART SUPERSTORE")], [], [conflicted]);
    const report = await categorise(deps, "frost", { range: RANGE, now: NOW });
    expect(report).toMatchObject({ conflicts: 1, uncategorised: 1, appended: 0 });
    expect(written).toEqual([]);
  });

  it("counts a qualifier that had nothing to qualify", async () => {
    // An inert refine names a missing merchant rule, which is the most
    // actionable thing a run can tell you about the rules themselves.
    const qualifierOnly = set({
      setId: "built-in",
      order: 2,
      rules: [
        {
          matcher: { kind: "merchant", pattern: "forecourt" },
          contributes: { kind: "refine", category: "fuel" },
          appliesTo: "debits",
        },
      ],
    });
    const { deps } = ledger([txRow("d1", "SOMEMART FORECOURT 118")], [], [qualifierOnly]);
    const report = await categorise(deps, "frost", { range: RANGE, now: NOW });
    expect(report).toMatchObject({ inertRefines: 1, uncategorised: 1, appended: 0 });
  });

  it("reports a stored category nothing matches any more, and does not touch it", async () => {
    const cat = stored({ category: "groceries" }) as unknown as Row;
    const { deps, written } = ledger([txRow("d1", "UTTERLY UNKNOWN")], [cat]);
    const report = await categorise(deps, "frost", { range: RANGE, now: NOW });
    expect(report).toMatchObject({ orphaned: 1, appended: 0, uncategorised: 0 });
    expect(written).toEqual([]);
  });

  it("matches on the provider category a transaction carries", async () => {
    const byProvider = set({
      setId: "provider-map",
      order: 3,
      rules: [
        {
          matcher: { kind: "providerCategory", value: "ATM" },
          contributes: { kind: "assert", category: "cash-withdrawal" },
          appliesTo: "debits",
        },
      ],
    });
    const row = { ...txRow("d1", "A CASHPOINT"), providerCategory: "ATM" };
    const { deps, written } = ledger([row], [], [byProvider]);
    await categorise(deps, "frost", { range: RANGE, now: NOW });
    expect(written[0]?.category).toBe("cash-withdrawal");
  });

  it("survives a row missing the fields a rule would read", async () => {
    // A scan returns whatever is stored. A row without a description is not a
    // reason to fail the run — it simply matches nothing.
    const { deps, written } = ledger([{ dedupKey: "d1", timestamp: "2026-02-01T00:00:00.000Z" }, {}]);
    const report = await categorise(deps, "frost", { range: RANGE, now: NOW });
    expect(report).toMatchObject({ scanned: 2, uncategorised: 2 });
    expect(written).toEqual([]);
  });

  it("skips a stored row that is not a categorisation, rather than failing the run", async () => {
    // A range query returns whatever shares the partition. A row that does not
    // parse is not this operation's business, and one bad row must not stop the
    // ledger being re-applied.
    const junk = { pk: "T#frost#TX", sk: "nonsense", something: "else" } as Row;
    const { deps } = ledger([txRow("d1", "SOMEMART SUPERSTORE")], [junk]);
    const report = await categorise(deps, "frost", { range: RANGE, now: NOW });
    expect(report).toMatchObject({ appended: 1, scanned: 1 });
  });

  it("ignores a provider category that is not a string", async () => {
    // Stored rows are whatever was written. Passing a number through as though
    // it were a category would make the candidate lie about its own shape.
    const byProvider = set({
      setId: "provider-map",
      order: 3,
      rules: [
        {
          matcher: { kind: "providerCategory", value: "ATM" },
          contributes: { kind: "assert", category: "cash-withdrawal" },
          appliesTo: "debits",
        },
      ],
    });
    const row = { ...txRow("d1", "A CASHPOINT"), providerCategory: 42 };
    const { deps, written } = ledger([row], [], [byProvider]);
    const report = await categorise(deps, "frost", { range: RANGE, now: NOW });
    expect(report).toMatchObject({ uncategorised: 1, appended: 0 });
    expect(written).toEqual([]);
  });

  it("decides everything and writes nothing on a dry run", async () => {
    const { deps, written } = ledger([txRow("d1", "SOMEMART SUPERSTORE")]);
    const report = await categorise(deps, "frost", { range: RANGE, now: NOW, dryRun: true });
    expect(report.appended).toBe(1);
    expect(written).toEqual([]);
  });
});
