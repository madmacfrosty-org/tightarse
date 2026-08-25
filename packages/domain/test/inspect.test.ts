import { describe, it, expect, vi } from "vitest";
import { backlog, inspection } from "../src/application/inspect.js";
import type { InspectDeps } from "../src/application/inspect.js";
import type { Row } from "../src/ports/outbound/index.js";

/**
 * Describing what the rules do not cover.
 *
 * The use case, not the collapse: `summariseCorpus` and `gatherEvidence` are
 * tested on their own, so what matters here is that both see the same corpus,
 * that categories come from the rules as they stand rather than from what the
 * last run wrote, and that one unreadable row does not cost the whole answer.
 *
 * Merchants here are invented. Real ones are household data and do not go in
 * files.
 */

const RANGE = { from: "2026-01-01", to: "2026-12-31" };

const row = (description: string, over: Partial<Row> = {}): Row => ({
  dedupKey: `d-${description}`,
  description,
  amount: -10_00,
  currency: "GBP",
  timestamp: "2026-01-05T00:00:00.000Z",
  ...over,
});

const ruleSetRow = (over: Record<string, unknown> = {}): Row => ({
  setId: "built-in",
  version: 1,
  name: "built-in",
  order: 2,
  authored: false,
  status: "effective",
  createdAt: "2026-01-01T00:00:00.000Z",
  rules: [
    {
      matcher: { kind: "merchant", pattern: "somemart" },
      contributes: { kind: "assert", category: "groceries" },
      appliesTo: "debits",
    },
  ],
  ...over,
});

const deps = (transactions: Row[], sets: Row[] = [ruleSetRow()]): InspectDeps => ({
  transactions: {
    listRange: vi.fn(async () => ({ transactions, categorisations: [] as Row[] })),
    listAccountRange: vi.fn(async () => [] as Row[]),
    putTransactions: vi.fn(async () => ({ written: 0 })),
    listPending: vi.fn(async () => [] as Row[]),
    replacePending: vi.fn(async () => ({ deleted: 0, written: 0 })),
  },
  ruleSets: {
    listRuleSets: vi.fn(async () => sets),
    listRuleSetHistory: vi.fn(async () => [] as Row[]),
    putRuleSetVersion: vi.fn(async () => undefined),
    decideRuleSetVersion: vi.fn(async () => undefined),
  } as unknown as InspectDeps["ruleSets"],
});

describe("describing the backlog", () => {
  it("collapses what the rules leave uncovered", async () => {
    const b = await backlog(deps([row("SOMEMART 118"), row("UNKNOWN SHOP")]), "frost", RANGE);

    expect(b.scanned).toBe(2);
    expect(b.gaps.map((g) => g.description)).toEqual(["UNKNOWN SHOP"]);
    expect(b.descriptions.map((d) => d.description).sort()).toEqual(["SOMEMART 118", "UNKNOWN SHOP"]);
  });

  it("takes the category from the rules as they stand, not from what was stored", async () => {
    // A stored category is what the last run concluded. When rules have changed
    // and nothing has re-applied them, that is the stale answer — and it would
    // hide exactly the gap a proposal is meant to fill.
    const b = await backlog(deps([row("SOMEMART 118")]), "frost", RANGE);
    const [only] = b.descriptions;

    expect(only).toMatchObject({ uncategorised: 0 });
    expect(only!.categories).toEqual([{ category: "groceries", transactions: 1 }]);
  });

  it("finds a recurring amount that arrives under a different description each time", async () => {
    const b = await backlog(
      deps([
        row("DD REF 1", { amount: -95_00, timestamp: "2026-01-05T00:00:00.000Z" }),
        row("DD REF 2", { amount: -95_00, timestamp: "2026-02-02T00:00:00.000Z" }),
        row("DD REF 3", { amount: -95_00, timestamp: "2026-03-02T00:00:00.000Z" }),
      ]),
      "frost",
      RANGE,
    );

    expect(b.recurrences).toHaveLength(1);
    expect(b.recurrences[0]).toMatchObject({ amount: -95_00, transactions: 3 });
  });

  it("names a set that claims two answers, which nothing else would report", async () => {
    // A conflicted transaction ends up categorised by nothing, and it is not a
    // gap either: a gap is where *nothing matched*, and here two rules matched
    // and disagreed. So without this it is uncategorised and invisible — absent
    // from the backlog it belongs in and from every count drawn off it.
    const clashing = ruleSetRow({
      setId: "household",
      order: 0,
      rules: [
        { matcher: { kind: "merchant", pattern: "somemart" }, contributes: { kind: "assert", category: "groceries" }, appliesTo: "debits" },
        { matcher: { kind: "merchant", pattern: "somemart" }, contributes: { kind: "assert", category: "fuel" }, appliesTo: "debits" },
      ],
    });
    const b = await backlog(deps([row("SOMEMART 118")], [clashing]), "frost", RANGE);

    expect(b.conflicts).toEqual([
      { setId: "household", categories: ["groceries", "fuel"], rules: [0, 1], transactions: 1, example: "SOMEMART 118" },
    ]);
    // Deliberately not a gap. Conflating the two would lose the distinction
    // between "no rule covers this" and "two rules fight over it", which are
    // different problems with different fixes.
    expect(b.gaps).toEqual([]);
    expect(b.descriptions[0]).toMatchObject({ uncategorised: 1 });
  });

  it("has no conflicts to report when the rules agree", async () => {
    const b = await backlog(deps([row("SOMEMART 118")]), "frost", RANGE);

    expect(b.conflicts).toEqual([]);
  });

  it("reads the ledger once, so the gaps and the collapses describe the same corpus", async () => {
    const d = deps([row("UNKNOWN SHOP")]);
    const b = await backlog(d, "frost", RANGE);

    expect(d.transactions.listRange).toHaveBeenCalledTimes(1);
    expect(d.transactions.listRange).toHaveBeenCalledWith("frost", RANGE);
    expect(b.gaps[0]!.description).toBe("UNKNOWN SHOP");
  });

  it("skips a rule set it cannot read rather than refusing to describe the ledger", async () => {
    // A scan returns whatever is stored. An unreadable set matches nothing,
    // which is exactly what it would do during application.
    const b = await backlog(deps([row("SOMEMART 118")], [{ setId: "broken" }, ruleSetRow()]), "frost", RANGE);

    expect(b.descriptions[0]!.categories).toEqual([{ category: "groceries", transactions: 1 }]);
  });

  it("treats a row with no timestamp as readable, because one bad row is not the ledger", async () => {
    const b = await backlog(deps([row("UNKNOWN SHOP", { timestamp: undefined })]), "frost", RANGE);

    expect(b.scanned).toBe(1);
    expect(b.recurrences).toEqual([]);
    // Empty, not the string "undefined" and not invented — a missing booking
    // date is missing, and anything that reads this can tell.
    expect(b.descriptions[0]).toMatchObject({ firstSeen: "", lastSeen: "" });
  });
});

describe("the inbound port", () => {
  it("passes the tenant and range straight through", async () => {
    const d = deps([row("SOMEMART 118")]);
    const b = await inspection(d).backlog("frost", RANGE);

    expect(d.transactions.listRange).toHaveBeenCalledWith("frost", RANGE);
    expect(b.scanned).toBe(1);
  });
});
