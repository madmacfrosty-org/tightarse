import { describe, it, expect } from "vitest";
import { buildPrompt, parseResponse } from "../src/categorise.js";
import { CATEGORIES, isCategory, type Candidate } from "@tightarse/domain";

/**
 * Overrides for a test-data builder.
 *
 * `Partial<T>` cannot express "remove this field" under
 * exactOptionalPropertyTypes, and a blanket `| undefined` would let a REQUIRED
 * field be blanked, which is a different bug. Undefined is allowed only where
 * the property is already optional.
 */
type Overrides<T> = { [K in keyof T]?: undefined extends T[K] ? T[K] | undefined : T[K] };

const cand = (over: Overrides<Candidate> = {}): Candidate =>
  // An optional field set to undefined is absent for our purposes; the spread
  // type cannot say that under exactOptionalPropertyTypes.
  ({
    dedupKey: "n:1",
    description: "TESCO STORES 3456",
    amount: -1299,
    currency: "GBP",
    providerCategory: "PURCHASE",
    ...over,
  }) as Candidate;

describe("buildPrompt", () => {
  it("shows amounts in major units, since that is how a human reads them", () => {
    expect(buildPrompt([cand()])).toContain("amount=-12.99 GBP");
  });

  it("indexes each line so responses can be matched back", () => {
    const p = buildPrompt([cand(), cand({ dedupKey: "n:2", description: "SHELL" })]);
    expect(p).toContain('0. "TESCO STORES 3456"');
    expect(p).toContain('1. "SHELL"');
  });

  it("omits the provider type when there is none", () => {
    expect(buildPrompt([cand({ providerCategory: undefined })])).not.toContain("type=");
  });
});

describe("parseResponse", () => {
  it("maps results back by index", () => {
    const cands = [cand(), cand({ dedupKey: "n:2" })];
    const out = parseResponse(cands, {
      results: [
        { i: 0, category: "Groceries", confidence: 0.95 },
        { i: 1, category: "Fuel", confidence: 0.8 },
      ],
    });
    expect(out.classifications).toEqual([
      { dedupKey: "n:1", category: "Groceries", confidence: 0.95 },
      { dedupKey: "n:2", category: "Fuel", confidence: 0.8 },
    ]);
  });

  it("rejects a category outside the taxonomy rather than storing it", () => {
    // An invented category would silently fragment every aggregation that
    // groups by it — "Supermarket" and "Groceries" as separate lines.
    const out = parseResponse([cand()], {
      results: [{ i: 0, category: "Supermarket", confidence: 0.99 }],
    });
    expect(out.rejected).toBe(1);
    expect(out.classifications[0]).toEqual({ dedupKey: "n:1", category: "Other", confidence: 0 });
  });

  it("leaves missing entries in the backlog instead of guessing", () => {
    // A truncated response must not result in fabricated categories; the
    // transaction simply stays outstanding and is picked up next run.
    const out = parseResponse([cand(), cand({ dedupKey: "n:2" })], {
      results: [{ i: 0, category: "Groceries", confidence: 0.9 }],
    });
    expect(out.classifications).toHaveLength(1);
    expect(out.missing).toBe(1);
  });

  it("treats an unparseable response as entirely missing", () => {
    const out = parseResponse([cand()], { nonsense: true });
    expect(out.classifications).toHaveLength(0);
    expect(out.missing).toBe(1);
  });

  it("tolerates results arriving out of order", () => {
    const cands = [cand(), cand({ dedupKey: "n:2" })];
    const out = parseResponse(cands, {
      results: [
        { i: 1, category: "Fuel", confidence: 0.7 },
        { i: 0, category: "Groceries", confidence: 0.9 },
      ],
    });
    expect(out.classifications[0]!.dedupKey).toBe("n:1");
    expect(out.classifications[1]!.category).toBe("Fuel");
  });
});

describe("taxonomy", () => {
  it("is closed, so aggregation groups cannot fragment", () => {
    expect(isCategory("Groceries")).toBe(true);
    expect(isCategory("groceries")).toBe(false);
    expect(isCategory("Supermarket")).toBe(false);
  });

  it("includes Other as a legitimate answer", () => {
    // A model pushed away from "Other" invents confident wrong categories, and
    // a misfiled transaction is far harder to spot than an uncategorised one.
    expect(CATEGORIES).toContain("Other");
  });
});
