import { describe, it, expect } from "vitest";
import { asBacklog } from "../src/wire.js";
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
  conflicts: [{
    setId: "household",
    categories: ["groceries", "fuel"],
    rules: [0, 3],
    transactions: 4,
    example: "SOMEMART FORECOURT",
  }],
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

    expect(out.recurrences[0]!.descriptions).not.toBe(backlog.recurrences[0]!.descriptions);
    expect(out.descriptions[0]!.categories).not.toBe(backlog.descriptions[0]!.categories);
    expect(out.gaps).not.toBe(backlog.gaps);
    expect(out.conflicts[0]!.categories).not.toBe(backlog.conflicts[0]!.categories);
    expect(out.conflicts[0]!.rules).not.toBe(backlog.conflicts[0]!.rules);
  });

  it("has nothing to say about an empty backlog, but still says the range", () => {
    expect(
      asBacklog(RANGE, { descriptions: [], recurrences: [], gaps: [], conflicts: [], scanned: 0 }),
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
