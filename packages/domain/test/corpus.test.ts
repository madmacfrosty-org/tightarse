import { describe, it, expect } from "vitest";
import { summariseCorpus, detectCadence } from "../src/categorisation/corpus.js";
import type { Sighting } from "../src/categorisation/corpus.js";

/**
 * Collapsing a ledger into the patterns a rule could be written for.
 *
 * The case this exists for is the direct debit whose reference changes every
 * month: it looks like a fresh merchant every time, so the description collapse
 * cannot see it, and only the amount collapse can. On real data that is the
 * common case rather than the exception.
 *
 * Merchants and amounts here are invented. Real ones are household data and do
 * not go in files.
 */

const BASE = Date.parse("2026-01-05T00:00:00.000Z");
const day = (n: number): string => new Date(BASE + n * 86_400_000).toISOString();

const seen = (over: Partial<Sighting> = {}): Sighting => ({
  description: "SOMEMART 118",
  amount: -12_50,
  timestamp: day(0),
  ...over,
});

/** Sightings of one amount on a fixed beat. */
const beat = (gap: number, count: number, over: Partial<Sighting> = {}): Sighting[] =>
  Array.from({ length: count }, (_, i) => seen({ ...over, timestamp: day(i * gap) }));

describe("collapsing by description", () => {
  it("counts sightings and totals what left the household", () => {
    const { descriptions } = summariseCorpus([
      seen({ amount: -10_00 }),
      seen({ amount: -5_00 }),
      seen({ description: "OTHERSHOP", amount: -1_00 }),
    ]);

    expect(descriptions).toHaveLength(2);
    expect(descriptions[0]).toMatchObject({ description: "SOMEMART 118", transactions: 2, outgoing: 15_00 });
  });

  it("leaves credits out of the outgoing total but still counts them", () => {
    const [only] = summariseCorpus([seen({ amount: -10_00 }), seen({ amount: 30_00 })]).descriptions;

    expect(only).toMatchObject({ transactions: 2, outgoing: 10_00 });
  });

  it("finds the first and last sighting whatever order they arrive in", () => {
    const [only] = summariseCorpus([
      seen({ timestamp: day(5) }),
      seen({ timestamp: day(9) }),
      seen({ timestamp: day(1) }),
    ]).descriptions;

    expect(only).toMatchObject({ firstSeen: day(1), lastSeen: day(9) });
  });

  it("tallies what the rules currently make of it, commonest first", () => {
    const [only] = summariseCorpus([
      seen({ category: "Groceries" }),
      seen({ category: "Fuel" }),
      seen({ category: "Groceries" }),
    ]).descriptions;

    expect(only!.categories).toEqual([
      { category: "Groceries", transactions: 2 },
      { category: "Fuel", transactions: 1 },
    ]);
    expect(only!.uncategorised).toBe(0);
  });

  it("orders equally-common categories by name, so two runs agree", () => {
    const [only] = summariseCorpus([seen({ category: "Groceries" }), seen({ category: "Fuel" })]).descriptions;

    expect(only!.categories.map((c) => c.category)).toEqual(["Fuel", "Groceries"]);
  });

  it("counts the uncategorised apart from the categorised", () => {
    const [only] = summariseCorpus([seen(), seen({ category: "Fuel" }), seen()]).descriptions;

    expect(only).toMatchObject({ uncategorised: 2, transactions: 3 });
    expect(only!.categories).toEqual([{ category: "Fuel", transactions: 1 }]);
  });

  it("puts the costliest description first, not the commonest", () => {
    const { descriptions } = summariseCorpus([
      ...Array.from({ length: 5 }, () => seen({ description: "FREQUENT", amount: -1_00 })),
      seen({ description: "EXPENSIVE", amount: -400_00 }),
    ]);

    expect(descriptions.map((d) => d.description)).toEqual(["EXPENSIVE", "FREQUENT"]);
  });

  it("orders equal-value descriptions by name, so the output is stable", () => {
    const { descriptions } = summariseCorpus([
      seen({ description: "BBB", amount: -5_00 }),
      seen({ description: "AAA", amount: -5_00 }),
    ]);

    expect(descriptions.map((d) => d.description)).toEqual(["AAA", "BBB"]);
  });
});

describe("detecting a beat", () => {
  it.each([
    [7, "weekly"],
    [14, "fortnightly"],
    [28, "four-weekly"],
    [30, "monthly"],
    [91, "quarterly"],
    [365, "annual"],
  ])("recognises a gap of %i days as %s", (gap, cadence) => {
    expect(detectCadence(beat(gap, 4).map((s) => s.timestamp))).toBe(cadence);
  });

  it("needs three sightings; two cannot establish a beat", () => {
    expect(detectCadence(beat(7, 3).map((s) => s.timestamp))).toBe("weekly");
    expect(detectCadence(beat(7, 2).map((s) => s.timestamp))).toBeUndefined();
  });

  it("accepts drift inside the tolerance and rejects it outside", () => {
    // Weekly tolerates two days: nine is late but regular, ten is a different beat.
    expect(detectCadence([day(0), day(9), day(18), day(27)])).toBe("weekly");
    expect(detectCadence([day(0), day(10), day(20), day(30)])).toBeUndefined();
  });

  it("survives a missed month, because the median ignores one long gap", () => {
    // Paid monthly, skipped one: gaps of 30, 60, 30, 30.
    expect(detectCadence([day(0), day(30), day(90), day(120), day(150)])).toBe("monthly");
  });

  it("ignores same-day repeats, which are a pair of payments and not a rhythm", () => {
    expect(detectCadence([day(0), day(0), day(0), day(0)])).toBeUndefined();
  });

  it("does not let same-day repeats drag the beat off a real rhythm", () => {
    // Four sightings on one day and then a weekly beat. Counting the zero gaps
    // would put the median at nothing and lose an obviously weekly payment.
    expect(detectCadence([day(0), day(0), day(0), day(0), day(7), day(14)])).toBe("weekly");
  });

  it("gives a tie to the shorter beat", () => {
    // Twenty-nine days is one day off four-weekly and one off monthly.
    expect(detectCadence([day(0), day(29), day(58), day(87)])).toBe("four-weekly");
  });

  it("takes the middle gap of the sorted gaps, not of the order they arrived", () => {
    // Gaps of 60, 7, 7, 60. Sorted, the middle is 60 and this is no rhythm;
    // read in arrival order the middle is 7 and it would pass as weekly.
    expect(detectCadence([day(0), day(60), day(67), day(74), day(134)])).toBeUndefined();
  });

  it("finds nothing in irregular dates", () => {
    expect(detectCadence([day(0), day(3), day(40), day(41)])).toBeUndefined();
  });

  it("reads the dates in whatever order they arrive", () => {
    expect(detectCadence([day(28), day(0), day(56)])).toBe("four-weekly");
  });
});

describe("collapsing by amount", () => {
  it("groups a recurring payment that arrives under a different description each time", () => {
    const { recurrences } = summariseCorpus([
      seen({ description: "DD REF 8803", amount: -95_00, timestamp: day(0) }),
      seen({ description: "DD REF 8802", amount: -95_00, timestamp: day(28) }),
      seen({ description: "DD REF 8801", amount: -95_00, timestamp: day(56) }),
    ]);

    expect(recurrences).toHaveLength(1);
    expect(recurrences[0]).toMatchObject({
      amount: -95_00,
      cadence: "four-weekly",
      transactions: 3,
      outgoing: 285_00,
      descriptions: ["DD REF 8801", "DD REF 8802", "DD REF 8803"],
      firstSeen: day(0),
      lastSeen: day(56),
    });
  });

  it("keeps a recurring credit, and keeps its sign", () => {
    const { recurrences } = summariseCorpus(beat(30, 4, { description: "PAYROLL", amount: 2_000_00 }));

    expect(recurrences[0]).toMatchObject({ amount: 2_000_00, cadence: "monthly", outgoing: 0 });
  });

  it("reports nothing for amounts that repeat without a beat", () => {
    expect(summariseCorpus([seen({ timestamp: day(0) }), seen({ timestamp: day(3) }), seen({ timestamp: day(40) })]).recurrences).toEqual([]);
  });

  it("counts how much of a recurrence the rules currently miss", () => {
    const { recurrences } = summariseCorpus([
      seen({ amount: -95_00, timestamp: day(0), category: "Utilities" }),
      seen({ amount: -95_00, timestamp: day(28) }),
      seen({ amount: -95_00, timestamp: day(56) }),
    ]);

    expect(recurrences[0]).toMatchObject({ uncategorised: 2 });
  });

  it("puts the costliest recurrence first", () => {
    const { recurrences } = summariseCorpus([
      ...beat(7, 4, { description: "SMALL", amount: -2_00 }),
      ...beat(30, 4, { description: "LARGE", amount: -500_00 }),
    ]);

    expect(recurrences.map((r) => r.amount)).toEqual([-500_00, -2_00]);
  });

  it("orders recurring credits by amount, which cost nothing and so always tie", () => {
    const { recurrences } = summariseCorpus([
      ...beat(7, 4, { description: "REFUND", amount: 3_00 }),
      ...beat(30, 4, { description: "PAYROLL", amount: 1_00 }),
    ]);

    expect(recurrences.map((r) => r.outgoing)).toEqual([0, 0]);
    expect(recurrences.map((r) => r.amount)).toEqual([1_00, 3_00]);
  });

  it("orders equally-valuable recurrences by amount, so two runs agree", () => {
    // Six payments of one hundred and three of two hundred cost the same.
    const { recurrences } = summariseCorpus([
      ...beat(7, 6, { description: "SMALL", amount: -1_00 }),
      ...beat(7, 3, { description: "LARGE", amount: -2_00 }),
    ]);

    expect(recurrences.map((r) => r.outgoing)).toEqual([6_00, 6_00]);
    expect(recurrences.map((r) => r.amount)).toEqual([-2_00, -1_00]);
  });
});

describe("the summary as a whole", () => {
  it("reports how much it looked at", () => {
    expect(summariseCorpus([seen(), seen(), seen()]).scanned).toBe(3);
  });

  it("has nothing to say about an empty ledger", () => {
    expect(summariseCorpus([])).toEqual({ descriptions: [], recurrences: [], scanned: 0 });
  });
});
