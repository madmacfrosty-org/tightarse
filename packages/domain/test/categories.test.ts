import { describe, it, expect } from "vitest";
import { effectiveCategories, orderOf } from "../src/reporting/categories.js";
import { recorded, type Overrides } from "./recorded.js";
import type { RecordedTransaction } from "../src/ledger/transaction.js";
import type { Row } from "../src/ports/outbound/index.js";

/**
 * Which category a report shows while two mechanisms overlap.
 *
 * Enrichment rows are what the ledger has; categorisation rows are what it is
 * moving to. Getting the preference wrong empties the dashboard, so it is worth
 * pinning rather than assuming.
 */

const tx = (
  dedupKey: string,
  over: Overrides<RecordedTransaction> = {},
): RecordedTransaction =>
  recorded({
    dedupKey,
    timestamp: "2026-02-01T00:00:00.000Z",
    amount: -10_00,
    accountId: "acc-1",
    description: "A MERCHANT",
    // Blank, so the only opinions in play are the stored ones these cases set up.
    providerCategory: undefined,
    ...over,
  });

const cat = (
  dedupKey: string,
  category: string,
  over: Record<string, unknown> = {},
): Row => ({
  dedupKey,
  timestamp: "2026-02-01T00:00:00.000Z",
  category,
  setId: "built-in",
  setVersion: 1,
  version: 1,
  status: "effective",
  appliedAt: "2026-02-02T00:00:00.000Z",
  ...over,
});

const order = [
  { setId: "household", order: 0 },
  { setId: "built-in", order: 2 },
];

describe("what a report shows", () => {
  it("keeps a category asserted by a rule set that matches on provider type", () => {
    // The regression. `provider` is the sentinel for "nothing categorised
    // this" — synthesised at read time and marked provisional everywhere. A
    // seeded rule set was also called `provider`, so everything it asserted was
    // discarded here as though no rule had matched, and an ATM withdrawal
    // categorised as cash was displayed as uncategorised.
    const out = effectiveCategories(
      [tx("d1", { providerCategory: "ATM" })],
      [cat("d1", "cash-withdrawal", { setId: "provider-types" })],
      [{ setId: "provider-types", order: 3 }],
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      category: "cash-withdrawal",
      setId: "provider-types",
    });
  });

  it("still drops the synthesised fallback, which is a rail and not an answer", () => {
    // The behaviour the filter is actually for: the provider's own transaction
    // type standing in for a category must not be promoted to one.
    const out = effectiveCategories(
      [tx("d1", { providerCategory: "ATM" })],
      [],
      [{ setId: "built-in", order: 2 }],
    );

    expect(out).toEqual([]);
  });

  it("takes what a rule set assigned, naming the set", () => {
    const out = effectiveCategories([tx("d1")], [cat("d1", "fuel")], order);
    expect(out).toHaveLength(1);
    expect(out).toMatchObject([
      { dedupKey: "d1", category: "fuel", setId: "built-in" },
    ]);
  });

  it("says nothing for a transaction no rule set has categorised", () => {
    // The enrichment rows the old mechanism wrote are no longer read: they are
    // answers no current rule produces and nothing can explain. Uncategorised
    // is the true answer, and it is the one that prompts a fix.
    expect(effectiveCategories([tx("d1")], [], order)).toEqual([]);
  });

  it("says nothing about a transaction neither has touched", () => {
    expect(effectiveCategories([tx("d1")], [], order)).toEqual([]);
  });

  it("takes the most trusted set when several have an opinion", () => {
    const out = effectiveCategories(
      [tx("d1")],
      [cat("d1", "shopping", { setId: "household" }), cat("d1", "fuel")],
      order,
    );
    expect(out).toHaveLength(1);
    expect(out).toMatchObject([
      { dedupKey: "d1", category: "shopping", setId: "household" },
    ]);
  });

  it("takes the newest version within a set", () => {
    const out = effectiveCategories(
      [tx("d1")],
      [
        cat("d1", "fuel", { version: 1 }),
        cat("d1", "transport", { version: 2 }),
      ],
      order,
    );
    expect(out[0]?.category).toBe("transport");
  });

  it("ignores a proposed version, which must not change what is displayed", () => {
    const out = effectiveCategories(
      [tx("d1")],
      [
        cat("d1", "fuel", { version: 1 }),
        cat("d1", "transport", { version: 2, status: "proposed" }),
      ],
      order,
    );
    expect(out[0]?.category).toBe("fuel");
  });

  it("does not promote the provider's own value to a category", () => {
    // The provider's is derived from the transaction rather than stored, and it
    // is a payment rail rather than a spending category. The reporting path
    // already falls back to it and marks it provisional, which is the honest
    // reading; promoting it here would quietly call it certain.
    const withProvider = tx("d1", { providerCategory: "PURCHASE" } as never);
    expect(effectiveCategories([withProvider], [], order)).toEqual([]);
  });

  it("shows nothing when the only version stored is proposed", () => {
    // A proposal must not change what is displayed, so a transaction whose only
    // categorisation is proposed reads as uncategorised rather than as decided.
    const out = effectiveCategories(
      [tx("d1")],
      [cat("d1", "fuel", { status: "proposed" })],
      order,
    );
    expect(out).toEqual([]);
  });

  it("skips a row that is not a categorisation rather than failing the report", () => {
    // A range query returns whatever shares the partition, and one bad row must
    // not stop a household seeing its spending.
    const junk = { pk: "T#frost#TX", sk: "nonsense" } as Row;
    const out = effectiveCategories(
      [tx("d1")],
      [junk, cat("d1", "fuel")],
      order,
    );
    expect(out).toHaveLength(1);
    expect(out).toMatchObject([
      { dedupKey: "d1", category: "fuel", setId: "built-in" },
    ]);
  });

  it("leaves a set it has no ranking for behind one it does", () => {
    // Ranking last rather than dropping: a categorisation invisible because
    // someone forgot to rank its set is a silent failure.
    const out = effectiveCategories(
      [tx("d1")],
      [cat("d1", "fuel"), cat("d1", "other", { setId: "mystery" })],
      order,
    );
    expect(out[0]?.category).toBe("fuel");
  });
});

describe("reading precedence from the sets", () => {
  it("takes setId and order, and nothing else", () => {
    expect(
      orderOf([{ setId: "household", order: 0, name: "x", rules: [] }]),
    ).toEqual([{ setId: "household", order: 0 }]);
  });

  it("ignores a row that cannot supply both", () => {
    // A malformed set must not become order NaN, which sorts unpredictably and
    // would make the effective category depend on scan order.
    expect(
      orderOf([
        { setId: "a" },
        { order: 1 },
        { setId: "b", order: 3 },
      ] as Row[]),
    ).toEqual([{ setId: "b", order: 3 }]);
  });
});
