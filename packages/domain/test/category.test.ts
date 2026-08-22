import { describe, it, expect } from "vitest";
import {
  Category,
  catalogueOf,
  kindOf,
  MAX_RESOLUTION_DEPTH,
  resolveCategory,
} from "../src/categorisation/category.js";
import { SEED_CATEGORIES, slugFor } from "../src/categorisation/seed.js";
import { CATEGORIES } from "../src/categorisation/taxonomy.js";

/**
 * Categories as entities, and following what a reference means now.
 *
 * The point of resolution is that a taxonomy change never requires reprocessing:
 * an old row keeps pointing at the old id, and the link is followed on read. So
 * what matters here is that the walk terminates, on every shape of bad data
 * someone can save.
 */

const category = (over: Partial<Category> & { id: string }): Category => ({
  label: over.id,
  kind: "spending",
  taxonomy: "household",
  retired: false,
  ...over,
});

describe("resolving what a reference means", () => {
  it("resolves a live category to itself", () => {
    const c = catalogueOf([category({ id: "groceries" })]);
    const r = resolveCategory("groceries", c);
    expect(r.category?.id).toBe("groceries");
    expect(r.path).toEqual(["groceries"]);
    expect(r.stopped).toBeUndefined();
  });

  it("follows a merge, so a retired category still resolves", () => {
    // Categories are never deleted. An old stored row points at "food-shopping"
    // for ever, and must still answer "Groceries" without anyone rewriting it.
    const c = catalogueOf([
      category({ id: "food-shopping", retired: true, mergedInto: "groceries" }),
      category({ id: "groceries", label: "Groceries" }),
    ]);
    const r = resolveCategory("food-shopping", c);
    expect(r.category?.label).toBe("Groceries");
    expect(r.path).toEqual(["food-shopping", "groceries"]);
  });

  it("follows a provider mapping to the household category it means", () => {
    // The provider produced its own category, not ours. The equivalence is an
    // assertion we own, which is why it is a link rather than a rename.
    const c = catalogueOf([
      category({ id: "tl-purchase", taxonomy: "provider", mapsTo: "shopping" }),
      category({ id: "shopping", label: "Shopping" }),
    ]);
    expect(resolveCategory("tl-purchase", c).category?.label).toBe("Shopping");
  });

  it("follows a chain of several links", () => {
    const c = catalogueOf([
      category({ id: "a", mergedInto: "b" }),
      category({ id: "b", mergedInto: "c" }),
      category({ id: "c" }),
    ]);
    const r = resolveCategory("a", c);
    expect(r.category?.id).toBe("c");
    expect(r.path).toEqual(["a", "b", "c"]);
  });
});

describe("data that would otherwise hang or lose the answer", () => {
  it("stops on a cycle rather than looping for ever", () => {
    // Two categories merged into each other. A data defect, not a state — but
    // this resolves on every read, so it has to end.
    const c = catalogueOf([
      category({ id: "a", mergedInto: "b" }),
      category({ id: "b", mergedInto: "a" }),
    ]);
    const r = resolveCategory("a", c);
    expect(r.stopped).toBe("cycle");
    expect(r.category?.id).toBe("b");
    // The path is what someone debugging the defect reads: it names the link
    // that closed the loop, which is the row that needs editing.
    expect(r.path).toEqual(["a", "b", "a"]);
  });

  it("stops on a self-merge, which is the shortest cycle there is", () => {
    const c = catalogueOf([category({ id: "a", mergedInto: "a" })]);
    expect(resolveCategory("a", c).stopped).toBe("cycle");
  });

  it("stops at the depth limit on a chain longer than anything legitimate", () => {
    const links = Array.from({ length: MAX_RESOLUTION_DEPTH + 3 }, (_, i) =>
      category({ id: `c${i}`, mergedInto: `c${i + 1}` }),
    );
    const c = catalogueOf([...links, category({ id: `c${MAX_RESOLUTION_DEPTH + 3}` })]);
    const r = resolveCategory("c0", c);
    expect(r.stopped).toBe("depth");
    expect(r.path).toHaveLength(MAX_RESOLUTION_DEPTH);
  });

  it("keeps the last category it found when a link names one nobody has", () => {
    // A broken link is not a reason to lose the answer entirely: "merged into
    // something missing" still tells you more than nothing at all.
    const c = catalogueOf([category({ id: "a", label: "A", mergedInto: "gone" })]);
    const r = resolveCategory("a", c);
    expect(r.stopped).toBe("missing");
    expect(r.category?.label).toBe("A");
    expect(r.path).toEqual(["a", "gone"]);
  });

  it("reports an id that is not in the catalogue at all", () => {
    const r = resolveCategory("never-existed", catalogueOf([]));
    expect(r.stopped).toBe("missing");
    expect(r.category).toBeUndefined();
  });
});

describe("kind, the only thing code may branch on", () => {
  it("reports the kind of the category a reference resolves to, not the one it names", () => {
    // A retired spending category merged into a movement one changes what the
    // totals should do with every old row pointing at it.
    const c = catalogueOf([
      category({ id: "old-transfer", kind: "spending", mergedInto: "transfer" }),
      category({ id: "transfer", kind: "movement" }),
    ]);
    expect(kindOf("old-transfer", c)).toBe("movement");
  });

  it("has no kind for a reference that resolves to nothing", () => {
    expect(kindOf("never-existed", catalogueOf([]))).toBeUndefined();
  });
});

describe("seeding the labels in service today", () => {
  it("produces exactly one entity per existing label, with the label unchanged", () => {
    // The migration must be invisible. A label that shifts by a character is a
    // relabelled chart and a support question.
    expect(SEED_CATEGORIES).toHaveLength(CATEGORIES.length);
    expect(SEED_CATEGORIES.map((c) => c.label)).toEqual([...CATEGORIES]);
  });

  it("gives every category a unique, readable id", () => {
    const ids = SEED_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("groceries");
    expect(ids).toContain("eating-out");
  });

  it("slugs punctuation out rather than through", () => {
    // "Gifts & Charity" must not become "gifts-&-charity" or "gifts--charity";
    // ids end up in rules and in URLs.
    expect(slugFor("Gifts & Charity")).toBe("gifts-charity");
    expect(slugFor("Rent & Mortgage")).toBe("rent-mortgage");
    expect(slugFor("  Spaced  Out  ")).toBe("spaced-out");
    // An ampersand joins two words, so it becomes a gap rather than nothing.
    // Dropping it would weld them: "R&D" reading "rd".
    expect(slugFor("R&D")).toBe("r-d");
  });

  it("marks income and transfers as what they are, and everything else as spending", () => {
    // Kind decides whether something counts as spend. Only these two are
    // unarguable, so only these two are assigned.
    const by = new Map(SEED_CATEGORIES.map((c) => [c.id, c.kind]));
    expect(by.get("income")).toBe("income");
    expect(by.get("transfer")).toBe("movement");
    expect(by.get("groceries")).toBe("spending");
    expect(by.get("savings-investments")).toBe("spending");
    expect(by.get("cash-withdrawal")).toBe("spending");
  });

  it("seeds nothing as retired, so every category can still be chosen", () => {
    // Retired stops new rules choosing a category. Seeding them retired would
    // quietly stop the whole taxonomy being usable.
    expect(SEED_CATEGORIES.every((c) => c.retired === false)).toBe(true);
  });

  it("parses as the schema, so a seeded catalogue is a valid one", () => {
    for (const c of SEED_CATEGORIES) expect(() => Category.parse(c)).not.toThrow();
  });
});
