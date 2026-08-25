import { describe, it, expect } from "vitest";
import {
  BacklogResponse,
  Cadence,
  CATEGORISATION_ROUTES,
  CategoryTallyView,
  ConflictView,
  DescriptionView,
  GapView,
  RecurrenceView,
  pathFor,
} from "../src/index";

/**
 * What the categorisation routes promise.
 *
 * These are not in the OpenAPI document — they are signed rather than
 * bearer-authorised, so a client generated from that document could not call
 * them — which means the snapshot that keeps every other route honest does not
 * cover these. This file is what stands in for it.
 */

const description = {
  description: "SOMEMART 118",
  transactions: 3,
  outgoing: 30_00,
  firstSeen: "2026-01-05T00:00:00.000Z",
  lastSeen: "2026-03-05T00:00:00.000Z",
  uncategorised: 1,
  categories: [{ category: "groceries", transactions: 2 }],
};

const recurrence = {
  amount: -95_00,
  cadence: "four-weekly" as const,
  transactions: 3,
  outgoing: 285_00,
  descriptions: ["DD REF 1", "DD REF 2"],
  firstSeen: "2026-01-05T00:00:00.000Z",
  lastSeen: "2026-03-02T00:00:00.000Z",
  uncategorised: 2,
};

describe("money on the wire", () => {
  it.each([
    ["DescriptionView.outgoing", DescriptionView.shape.outgoing, "under this description"],
    ["RecurrenceView.outgoing", RecurrenceView.shape.outgoing, "across the whole series"],
    ["RecurrenceView.amount", RecurrenceView.shape.amount, "repeated amount"],
    ["GapView.outgoing", GapView.shape.outgoing, "under it"],
  ])("%s says it is in minor units, and what it counts", (_name, schema, what) => {
    // A client that loses the unit is wrong by a factor of 100 on every screen,
    // and the mistake is invisible until somebody looks at a real figure. The
    // second half matters too: four fields carrying "minor units" and nothing
    // else are four fields a client author cannot tell apart.
    expect(schema.description).toContain("minor units");
    expect(schema.description).toContain(what);
  });

  it("keeps a recurring amount signed, so a credit stays a credit", () => {
    expect(RecurrenceView.shape.amount.description).toContain("signed");
    expect(RecurrenceView.parse({ ...recurrence, amount: 2_000_00 }).amount).toBe(2_000_00);
  });
});

describe("what a description promises", () => {
  it("accepts a described merchant with its current categories", () => {
    expect(DescriptionView.parse(description)).toEqual(description);
  });

  it.each(["transactions", "uncategorised"] as const)("refuses a negative %s", (field) => {
    expect(() => DescriptionView.parse({ ...description, [field]: -1 })).toThrow();
  });

  it("refuses a fractional count, which would mean a transaction split in half", () => {
    expect(() => DescriptionView.parse({ ...description, transactions: 1.5 })).toThrow();
  });

  it("says when it is sightings the rules give no category", () => {
    expect(DescriptionView.shape.uncategorised.description).toContain("no category");
  });

  it("warns that more than one category means inconsistency, not a list", () => {
    expect(DescriptionView.shape.categories.description).toContain("inconsistently");
  });

  it("says both timestamps are ISO-8601, which is what a client has to parse", () => {
    expect(DescriptionView.shape.firstSeen.description).toContain("ISO-8601");
    expect(DescriptionView.shape.lastSeen.description).toContain("ISO-8601");
  });

  it("names what a category identifier is", () => {
    expect(CategoryTallyView.shape.category.description).toContain("category");
  });
});

describe("the beats a client has to understand", () => {
  it.each(["weekly", "fortnightly", "four-weekly", "monthly", "quarterly", "annual"])(
    "recognises %s",
    (cadence) => {
      expect(Cadence.parse(cadence)).toBe(cadence);
    },
  );

  it("recognises those six and nothing else", () => {
    expect(Cadence.options).toHaveLength(6);
    expect(() => Cadence.parse("daily")).toThrow();
    expect(() => Cadence.parse("4-weekly")).toThrow();
  });

  it("says what the enum is for", () => {
    expect(Cadence.description).toContain("beat");
  });
});

describe("what a recurrence promises", () => {
  it("accepts a repeated amount with every description it arrived under", () => {
    expect(RecurrenceView.parse(recurrence)).toEqual(recurrence);
  });

  it("says that more than one description is the case it exists for", () => {
    expect(RecurrenceView.shape.descriptions.description).toContain("More than one");
  });

  it("refuses a cadence it does not know", () => {
    expect(() => RecurrenceView.parse({ ...recurrence, cadence: "hourly" })).toThrow();
  });
});

describe("the backlog envelope", () => {
  it("carries the range it answered, alongside every collapse", () => {
    const response = {
      range: { from: "2026-01-01", to: "2026-12-31" },
      descriptions: [description],
      recurrences: [recurrence],
      gaps: [{ description: "UNKNOWN SHOP", transactions: 2, outgoing: 15_00 }],
      conflicts: [
        { setId: "household", categories: ["groceries", "fuel"], rules: [0, 3], transactions: 4, example: "SOMEMART FORECOURT" },
      ],
      scanned: 5,
    };

    expect(BacklogResponse.parse(response)).toEqual(response);
  });

  it.each(["descriptions", "recurrences", "gaps"] as const)("orders %s costliest first", (field) => {
    expect(BacklogResponse.shape[field].description).toContain("costliest first");
  });

  it("requires the range, so a client can tell what was served from what it asked", () => {
    expect(() =>
      BacklogResponse.parse({ descriptions: [], recurrences: [], gaps: [], conflicts: [], scanned: 0 }),
    ).toThrow();
  });
});

describe("what a conflict promises", () => {
  const conflict = {
    setId: "household",
    categories: ["groceries", "fuel"],
    rules: [0, 3],
    transactions: 4,
    example: "SOMEMART FORECOURT",
  };

  it("names the set, the categories it cannot choose between, and where to look", () => {
    expect(ConflictView.parse(conflict)).toEqual(conflict);
  });

  it("identifies rules by position, which is how the fold identifies them", () => {
    expect(ConflictView.shape.rules.description).toContain("Positions within the set");
    expect(() => ConflictView.parse({ ...conflict, rules: [-1] })).toThrow();
    expect(() => ConflictView.parse({ ...conflict, rules: [1.5] })).toThrow();
  });

  it("carries one example, for a human deciding which rule is wrong", () => {
    expect(ConflictView.shape.example.description).toContain("which rule is wrong");
  });

  it("names the set and what it is torn between", () => {
    expect(ConflictView.shape.setId.description).toContain("cannot choose");
    expect(ConflictView.shape.categories.description).toContain("claims at once");
  });

  it("says what a conflict is, because a bare list would look like a second gap list", () => {
    // Spans all three halves of the concatenated description, so losing any one
    // fails rather than passing on whichever survives.
    const said = BacklogResponse.shape.conflicts.description ?? "";

    expect(said).toContain("widest first");
    expect(said).toContain("gap with a cause");
    expect(said).toContain("produces nothing");
    expect(said).toContain("written for them");
  });

  it("requires conflicts in the envelope, so absent means none rather than not looked", () => {
    expect(() =>
      BacklogResponse.parse({
        range: { from: "2026-01-01", to: "2026-12-31" },
        descriptions: [],
        recurrences: [],
        gaps: [],
        scanned: 0,
      }),
    ).toThrow();
  });
});

describe("the signed routes", () => {
  it("serves the backlog at a versioned path", () => {
    expect(CATEGORISATION_ROUTES).toHaveLength(1);
    expect(pathFor(CATEGORISATION_ROUTES[0]!)).toBe("/v1/categorisation/gaps");
  });

  it("is a GET taking both ends of a range, both required", () => {
    const [route] = CATEGORISATION_ROUTES;

    expect(route!.method).toBe("get");
    expect(route!.path).toBe("/categorisation/gaps");
    expect(route!.query.map((q) => q.name)).toEqual(["from", "to"]);
    expect(route!.query.every((q) => q.required)).toBe(true);
  });

  it("answers with the backlog, named so a generated client gets one struct", () => {
    expect(CATEGORISATION_ROUTES[0]!.response.name).toBe("BacklogResponse");
    expect(CATEGORISATION_ROUTES[0]!.response.schema).toBe(BacklogResponse);
  });

  it("says what it is for, and that it does not paginate", () => {
    const [route] = CATEGORISATION_ROUTES;

    expect(route!.summary).toContain("rules do not yet cover");
    // Spans both halves of the concatenated description, so losing either one
    // fails rather than passing on the surviving half.
    expect(route!.description).toContain("Every distinct description");
    expect(route!.description).toContain("costliest first");
    expect(route!.description).toContain("no pagination");
    // The distinction the whole endpoint turns on: a gap here is a gap now,
    // not what the last application happened to conclude.
    expect(route!.description).toContain("as they stand");
  });
});
