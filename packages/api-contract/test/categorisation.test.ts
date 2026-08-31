import { describe, it, expect } from "vitest";
import {
  BacklogResponse,
  Cadence,
  CATEGORISATION_ROUTES,
  CategoryTallyView,
  ConflictView,
  DescriptionView,
  GapView,
  ProposalRequest,
  ProposalResponse,
  RecurrenceView,
  pathFor,
  ROUTES,
} from "../src/index.js";

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
  const gaps = CATEGORISATION_ROUTES.find((r) => r.path === "/categorisation/gaps")!;
  const proposals = CATEGORISATION_ROUTES.find((r) => r.path === "/categorisation/proposals")!;

  it("publishes exactly these, at versioned paths", () => {
    expect(CATEGORISATION_ROUTES.map((r) => pathFor(r)).sort()).toEqual([
      "/v1/categories",
      "/v1/categorisation/gaps",
      "/v1/categorisation/proposals",
    ]);
  });

  it("reads categories on one function and writes them on the other", () => {
    // The dashboard's function is read-only by design, so the pair splits: the
    // list is a read it serves, and adding one is a write it must not do.
    expect(ROUTES.some((r) => r.path === "/categories" && r.method === "get")).toBe(true);
    const add = CATEGORISATION_ROUTES.find((r) => r.path === "/categories")!;
    expect(add.method).toBe("post");
    expect(add.request?.name).toBe("NewCategoryRequest");
  });

  it("reads the backlog with a GET taking both ends of a range", () => {
    expect(gaps.method).toBe("get");
    expect(gaps.query.map((q) => q.name)).toEqual(["from", "to"]);
    expect(gaps.query.every((q) => q.required)).toBe(true);
    expect(gaps.request).toBeUndefined();
  });

  it("answers the backlog with one named struct a generated client can use", () => {
    expect(gaps.response.name).toBe("BacklogResponse");
    expect(gaps.response.schema).toBe(BacklogResponse);
  });

  it("says what the backlog is for, and that it does not paginate", () => {
    expect(gaps.summary).toContain("rules do not yet cover");
    expect(gaps.description).toContain("Every distinct description");
    expect(gaps.description).toContain("costliest first");
    expect(gaps.description).toContain("no pagination");
    // The distinction the whole endpoint turns on: a gap here is a gap now,
    // not what the last application happened to conclude.
    expect(gaps.description).toContain("as they stand");
  });

  it("proposes with a POST that carries the sets and returns what they would do", () => {
    expect(proposals.method).toBe("post");
    expect(proposals.request?.name).toBe("ProposalRequest");
    expect(proposals.request?.schema).toBe(ProposalRequest);
    expect(proposals.response.name).toBe("ProposalResponse");
    expect(proposals.response.schema).toBe(ProposalResponse);
  });

  it("takes a range to measure against, and how far to take it", () => {
    const byName = Object.fromEntries(proposals.query.map((q) => [q.name, q]));

    expect(Object.keys(byName).sort()).toEqual(["commit", "from", "to"]);
    expect(byName["from"]!.required).toBe(true);
    expect(byName["to"]!.required).toBe(true);
    expect(byName["commit"]!.required).toBe(false);
  });

  it("offers exactly three degrees of commitment, and no fourth", () => {
    // One parameter rather than two flags: a dry run that also applies is a
    // combination with no meaning, and every two-boolean API is eventually
    // sent it.
    const commit = proposals.query.find((q) => q.name === "commit")!;

    for (const value of ["preview", "propose", "apply"]) expect(commit.schema.parse(value)).toBe(value);
    expect(() => commit.schema.parse("true")).toThrow();
    expect(() => commit.schema.parse("APPLY")).toThrow();
  });

  it("says what each degree does, and which one it assumes", () => {
    const commit = proposals.query.find((q) => q.name === "commit")!;

    expect(commit.description).toContain("writes nothing");
    expect(commit.description).toContain("awaiting a decision");
    expect(commit.description).toContain("recategorises the range");
    expect(commit.description).toContain("Absent means `propose`");
  });

  it("names every outcome it reports, across the whole description", () => {
    // Spans all three halves of the concatenated text, so losing any one fails
    // rather than passing on whichever survives.
    expect(proposals.summary).toContain("Propose a change to the rules");
    expect(proposals.description).toContain("gain, lose, recategorise");
    expect(proposals.description).toContain("conflict they would introduce");
    expect(proposals.description).toContain("marked");
  });

  it("says the prediction is computed here, not taken from the caller", () => {
    // The whole arrangement: a model may write rules, and only deterministic
    // code says what they do.
    expect(proposals.description).toContain("never taken from the caller");
  });

  it("names all three degrees in its own description", () => {
    expect(proposals.description).toContain("computing only");
    expect(proposals.description).toContain("recategorising the range");
  });
});
