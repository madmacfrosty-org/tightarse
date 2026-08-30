import { describe, it, expect } from "vitest";
import { asBacklog, asCategories, asProposalResponse } from "../src/wire.js";
import type { Backlog } from "@tightarse/domain";

/**
 * Where a domain answer becomes an HTTP response.
 *
 * Asserted field by field rather than by spot check. This file exists because
 * the domain result and the wire promise change for different reasons, so a
 * test that looks at three fields and shrugs at the rest would let the two drift
 * apart silently — which is the exact failure the translation is here to catch.
 *
 * Merchants here are invented. Real ones are household data and do not go in
 * files.
 */

const RANGE = { from: "2026-01-01", to: "2026-12-31" };

const backlog: Backlog = {
  descriptions: [
    {
      description: "SOMEMART 118",
      transactions: 3,
      outgoing: 30_00,
      firstSeen: "2026-01-05T00:00:00.000Z",
      lastSeen: "2026-03-05T00:00:00.000Z",
      uncategorised: 1,
      categories: [
        { category: "groceries", transactions: 1 },
        { category: "fuel", transactions: 1 },
      ],
    },
  ],
  recurrences: [
    {
      amount: -95_00,
      cadence: "four-weekly",
      transactions: 3,
      outgoing: 285_00,
      descriptions: ["DD REF 1", "DD REF 2"],
      firstSeen: "2026-01-05T00:00:00.000Z",
      lastSeen: "2026-03-02T00:00:00.000Z",
      uncategorised: 2,
    },
  ],
  gaps: [{ description: "UNKNOWN SHOP", transactions: 2, outgoing: 15_00 }],
  conflicts: [
    {
      setId: "household",
      categories: ["groceries", "fuel"],
      rules: [0, 3],
      transactions: 4,
      example: "SOMEMART FORECOURT",
    },
  ],
  scanned: 5,
};

describe("the backlog on the wire", () => {
  it("carries every field across, and no others", () => {
    expect(asBacklog(RANGE, backlog)).toEqual({
      range: { from: "2026-01-01", to: "2026-12-31" },
      descriptions: [
        {
          description: "SOMEMART 118",
          transactions: 3,
          outgoing: 30_00,
          firstSeen: "2026-01-05T00:00:00.000Z",
          lastSeen: "2026-03-05T00:00:00.000Z",
          uncategorised: 1,
          categories: [
            { category: "groceries", transactions: 1 },
            { category: "fuel", transactions: 1 },
          ],
        },
      ],
      recurrences: [
        {
          amount: -95_00,
          cadence: "four-weekly",
          transactions: 3,
          outgoing: 285_00,
          descriptions: ["DD REF 1", "DD REF 2"],
          firstSeen: "2026-01-05T00:00:00.000Z",
          lastSeen: "2026-03-02T00:00:00.000Z",
          uncategorised: 2,
        },
      ],
      gaps: [{ description: "UNKNOWN SHOP", transactions: 2, outgoing: 15_00 }],
      conflicts: [
        {
          setId: "household",
          categories: ["groceries", "fuel"],
          rules: [0, 3],
          transactions: 4,
          example: "SOMEMART FORECOURT",
        },
      ],
      scanned: 5,
    });
  });

  it("copies the arrays rather than handing out the domain's own", () => {
    // The domain returns readonly arrays because a result is not the caller's
    // to mutate. Serving the same object would let a later handler reach back
    // into the aggregation's memory.
    const out = asBacklog(RANGE, backlog);

    expect(out.recurrences[0]!.descriptions).not.toBe(
      backlog.recurrences[0]!.descriptions,
    );
    expect(out.descriptions[0]!.categories).not.toBe(
      backlog.descriptions[0]!.categories,
    );
    expect(out.gaps).not.toBe(backlog.gaps);
    expect(out.conflicts[0]!.categories).not.toBe(
      backlog.conflicts[0]!.categories,
    );
    expect(out.conflicts[0]!.rules).not.toBe(backlog.conflicts[0]!.rules);
  });

  it("has nothing to say about an empty backlog, but still says the range", () => {
    expect(
      asBacklog(RANGE, {
        descriptions: [],
        recurrences: [],
        gaps: [],
        conflicts: [],
        scanned: 0,
      }),
    ).toEqual({
      range: RANGE,
      descriptions: [],
      recurrences: [],
      gaps: [],
      conflicts: [],
      scanned: 0,
    });
  });
});

describe("the catalogue on the wire", () => {
  it("carries every field a picker reads", () => {
    const result = {
      categories: [{ id: "fuel", label: "Fuel", kind: "spending" }],
    };

    expect(asCategories(result)).toEqual({
      categories: [{ id: "fuel", label: "Fuel", kind: "spending" }],
    });
  });

  it("copies rather than serving the domain's own array", () => {
    const result = {
      categories: [{ id: "fuel", label: "Fuel", kind: "spending" }],
    };

    expect(asCategories(result).categories).not.toBe(result.categories);
  });

  it("has nothing to offer an empty catalogue", () => {
    expect(asCategories({ categories: [] })).toEqual({ categories: [] });
  });
});

describe("the prediction on the wire", () => {
  const change = (n: number) => ({
    dedupKey: `d${n}`,
    description: `SHOP ${n}`,
    from: "shopping",
    to: "fuel",
  });
  const effect = (n: number) => ({
    transactions: n,
    outgoing: n * 100,
    merchants: n,
    entries: Array.from({ length: n }, (_, i) => change(i)),
  });
  const prediction = {
    gained: effect(2),
    lost: effect(1),
    recategorised: effect(3),
    unchanged: effect(1),
    outranked: effect(1),
    introducedConflicts: [
      {
        setId: "household",
        categories: ["a", "b"],
        transactions: 2,
        example: "SHOP 1",
      },
    ],
    scanned: 8,
  };

  it("carries all five outcomes and the conflicts it would introduce", () => {
    const out = asProposalResponse(prediction as never);

    expect(out.prediction.gained).toMatchObject({
      transactions: 2,
      outgoing: 200,
      merchants: 2,
    });
    expect(out.prediction.recategorised.transactions).toBe(3);
    expect(out.prediction.introducedConflicts).toEqual([
      {
        setId: "household",
        categories: ["a", "b"],
        transactions: 2,
        example: "SHOP 1",
      },
    ]);
    expect(out.prediction.scanned).toBe(8);
  });

  it("says when it truncated, and never truncates without saying", () => {
    // A caller shown a fraction and told nothing draws a conclusion from it.
    const many = { ...prediction, gained: effect(600) };
    const out = asProposalResponse(many as never);

    expect(out.prediction.gained.transactions).toBe(600);
    expect(out.prediction.gained.entries).toHaveLength(500);
    expect(out.prediction.gained.truncated).toBe(true);
  });

  it("says so plainly when nothing was dropped", () => {
    expect(
      asProposalResponse(prediction as never).prediction.gained.truncated,
    ).toBe(false);
  });

  it("keeps every recategorised transaction, because that is the group worth reading", () => {
    const many = { ...prediction, recategorised: effect(900) };
    const out = asProposalResponse(many as never);

    expect(out.prediction.recategorised.entries).toHaveLength(900);
    expect(out.prediction.recategorised.truncated).toBe(false);
  });

  it("names the versions it wrote", () => {
    const out = asProposalResponse(prediction as never, [
      { setId: "household", version: 4, rules: 3 },
    ]);

    expect(out.proposed).toEqual([{ setId: "household", version: 4 }]);
  });

  it("names nothing on a dry run, because it created nothing", () => {
    expect(asProposalResponse(prediction as never).proposed).toBeUndefined();
  });

  it("leaves out a category that was never there, rather than sending null", () => {
    const uncategorised = {
      ...prediction,
      gained: {
        transactions: 1,
        outgoing: 0,
        merchants: 1,
        entries: [{ dedupKey: "d1", description: "X" }],
      },
    };
    const out = asProposalResponse(uncategorised as never);

    expect(out.prediction.gained.entries[0]).toEqual({
      dedupKey: "d1",
      description: "X",
    });
    expect("from" in out.prediction.gained.entries[0]!).toBe(false);
  });
});

describe("what applying did", () => {
  const prediction = {
    gained: { transactions: 0, outgoing: 0, merchants: 0, entries: [] },
    lost: { transactions: 0, outgoing: 0, merchants: 0, entries: [] },
    recategorised: { transactions: 0, outgoing: 0, merchants: 0, entries: [] },
    unchanged: { transactions: 0, outgoing: 0, merchants: 0, entries: [] },
    outranked: { transactions: 0, outgoing: 0, merchants: 0, entries: [] },
    introducedConflicts: [],
    scanned: 0,
  };
  const report = {
    scanned: 47,
    unchanged: 5,
    appended: 42,
    orphaned: 0,
    uncategorised: 3,
    conflicts: 0,
    inertRefines: 1,
    appliedBy: "someone",
  };

  it("reports what actually happened, next to what was predicted", () => {
    // Counts, not rows: which transactions changed is a re-application away,
    // and this is what makes a prediction checkable rather than merely stated.
    const out = asProposalResponse(
      prediction as never,
      undefined,
      report as never,
    );

    expect(out.applied).toEqual({
      scanned: 47,
      unchanged: 5,
      appended: 42,
      orphaned: 0,
      uncategorised: 3,
      conflicts: 0,
      inertRefines: 1,
    });
  });

  it("carries nothing about applying when nothing was applied", () => {
    expect(asProposalResponse(prediction as never).applied).toBeUndefined();
    expect(
      asProposalResponse(prediction as never, [
        { setId: "household", version: 4, rules: 1 },
      ]).applied,
    ).toBeUndefined();
  });
});
