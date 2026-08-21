import { describe, it, expect } from "vitest";
import { observationVersion, providerCategorisation, PROVIDER_SET } from "../src/provider";

const tx = {
  dedupKey: "d1",
  timestamp: "2026-03-01T00:00:00Z",
  providerCategory: "ATM",
  ingestedAt: "2026-08-17T05:00:00Z",
};

describe("the provider's own classification", () => {
  it("becomes a categorisation attributed to the provider set", () => {
    const c = providerCategorisation(tx)!;
    expect(c.setId).toBe(PROVIDER_SET);
    expect(c.dedupKey).toBe("d1");
    expect(c.version).toBe(1);
  });

  it("keeps the provider's own value rather than mapping it here", () => {
    // These are categories in the PROVIDER'S taxonomy. Mapping one to a
    // household category is an assertion between categories, made elsewhere —
    // and for most provider values there is deliberately no mapping at all,
    // which is why 100% provider coverage does not mean 100% categorised.
    expect(providerCategorisation({ ...tx, providerCategory: "PURCHASE" })!.category).toBe("PURCHASE");
  });

  it("names no rule, because none can be named", () => {
    // The case `rules` is a list for. We know the categoriser and roughly when;
    // we cannot know why it chose.
    expect(providerCategorisation(tx)!.rules).toEqual([]);
  });

  it("falls back to the transaction's own time when we did not record the fetch", () => {
    // Older rows predate the ingest stamp. A categorisation still needs a
    // timestamp, and the transaction's own is the only honest one available.
    const c = providerCategorisation({ ...tx, ingestedAt: undefined })!;
    expect(c.appliedAt).toBe("2026-03-01T00:00:00Z");
    expect(c.setVersion).toBe(0);
  });

  it("produces nothing when the provider classified nothing", () => {
    expect(providerCategorisation({ ...tx, providerCategory: undefined })).toBeUndefined();
    // Empty string is absence, not a category.
    expect(providerCategorisation({ ...tx, providerCategory: "" })).toBeUndefined();
  });
});

describe("the observation stamp", () => {
  it("records the day we looked, not a version of their logic", () => {
    // The provider publishes no taxonomy version. Calling this a version would
    // imply we could detect a change in how they classify; we could not.
    expect(observationVersion("2026-08-17T05:00:00Z")).toBe(20260817);
  });

  it("sorts an unstamped reading first, which is where it belongs", () => {
    // Least trustworthy, so least precedence within the set.
    expect(observationVersion(undefined)).toBe(0);
    expect(observationVersion("not-a-date")).toBe(0);
  });

  it("orders chronologically as a number", () => {
    // A lexical comparison would be fine here, but the field is numeric, so it
    // has to survive being treated as one.
    expect(observationVersion("2026-01-09T00:00:00Z")).toBeLessThan(observationVersion("2026-01-10T00:00:00Z"));
    expect(observationVersion("2025-12-31T00:00:00Z")).toBeLessThan(observationVersion("2026-01-01T00:00:00Z"));
  });
});
