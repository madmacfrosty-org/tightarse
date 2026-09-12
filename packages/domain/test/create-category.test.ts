import { describe, it, expect, vi } from "vitest";
import { createCategory } from "../src/application/categories.js";
import type { CategoryDeps } from "../src/application/categories.js";
import type { Row } from "../src/ports/outbound/index.js";

/**
 * Adding a category.
 *
 * The failure worth preventing is the quiet one: `putCategory` overwrites in
 * place, so a second category whose label slugs to an id already in use would
 * rename one that rules and stored categorisations already name.
 */

const deps = (existing: Row[] = []) => {
  const written: unknown[] = [];
  const d: CategoryDeps & { written: unknown[] } = {
    written,
    categories: {
      listCategories: vi.fn(async () => existing),
      putCategory: vi.fn(async (_t: string, c: unknown) => {
        written.push(c);
      }),
    } as unknown as CategoryDeps["categories"],
  };
  return d;
};

const stored = (id: string, label: string): Row => ({
  id,
  label,
  nature: "expense",
  taxonomy: "household",
  retired: false,
});

describe("adding a category", () => {
  it("derives the id from the label, as the seed does", async () => {
    const d = deps();
    const c = await createCategory(d, "frost", { label: "Eating Out" });

    expect(c).toEqual({
      id: "eating-out",
      label: "Eating Out",
      nature: "expense",
      taxonomy: "household",
      retired: false,
    });
    expect(d.written).toEqual([c]);
  });

  it("keeps the label as written, since it is what a person reads", async () => {
    const c = await createCategory(deps(), "frost", {
      label: "  Home & Garden  ",
    });

    expect(c.label).toBe("Home & Garden");
    expect(c.id).toBe("home-garden");
  });

  it("files it as spending when nothing says otherwise", async () => {
    // What nearly everything filed from a list of debits is.
    expect(
      (await createCategory(deps(), "frost", { label: "Something" })).nature,
    ).toBe("expense");
  });

  it.each(["income", "asset", "liability", "expense"] as const)(
    "takes %s, because totals branch on it",
    async (nature) => {
      // Money into savings filed as spending overstates every spending figure
      // from then on, invisibly.
      expect(
        (await createCategory(deps(), "frost", { label: "Something", nature }))
          .nature,
      ).toBe(nature);
    },
  );

  it("refuses a label that leaves nothing to name it by", async () => {
    const d = deps();
    await expect(createCategory(d, "frost", { label: "!!!" })).rejects.toThrow(
      /letters or numbers/,
    );
    expect(d.written).toEqual([]);
  });

  it("refuses a label that is only spaces", async () => {
    await expect(
      createCategory(deps(), "frost", { label: "   " }),
    ).rejects.toThrow();
  });

  it("refuses a duplicate rather than overwriting one", async () => {
    // `putCategory` overwrites in place. Silently replacing would rename a
    // category that rules and stored categorisations already name.
    const d = deps([stored("eating-out", "Eating Out")]);

    await expect(
      createCategory(d, "frost", { label: "eating out" }),
    ).rejects.toThrow(/already uses/);
    expect(d.written).toEqual([]);
  });

  it("names the one that already has it, so the answer is to use that", async () => {
    const d = deps([stored("eating-out", "Eating Out")]);

    await expect(
      createCategory(d, "frost", { label: "Eating  Out" }),
    ).rejects.toThrow(/“Eating Out” already uses the name eating-out/);
  });

  it("says a taken name is a conflict, not a fault", async () => {
    // An adapter that cannot tell the two apart reports "internal error" and
    // hides the sentence that says what to do instead.
    const d = deps([stored("eating-out", "Eating Out")]);

    await expect(
      createCategory(d, "frost", { label: "Eating Out" }),
    ).rejects.toMatchObject({
      name: "CategoryExists",
      existing: { id: "eating-out", label: "Eating Out" },
    });
  });

  it("refuses a duplicate of a retired category too", async () => {
    // The id is taken either way, and reusing it would resurrect something
    // that was deliberately put beyond use.
    const d = deps([{ ...stored("petrol", "Petrol"), retired: true }]);

    await expect(
      createCategory(d, "frost", { label: "Petrol" }),
    ).rejects.toThrow(/already uses/);
  });

  it("ignores a stored row it cannot read rather than refusing to add anything", async () => {
    const d = deps([{ id: "broken" }, stored("fuel", "Fuel")]);

    expect((await createCategory(d, "frost", { label: "Petrol" })).id).toBe(
      "petrol",
    );
  });

  it("adds to an empty catalogue", async () => {
    expect((await createCategory(deps(), "frost", { label: "First" })).id).toBe(
      "first",
    );
  });
});

/**
 * `liability` is the value `kind` could never express.
 *
 * Three values and none of them said "owed". That gap is the whole reason the
 * field was replaced rather than renamed, so it is worth one test of its own.
 *
 * Labels are invented.
 */
describe("a category that is a debt", () => {
  it("can be created, which the old three values could not do", async () => {
    const made = await createCategory(deps(), "t1", {
      label: "Mortgage",
      nature: "liability",
    });
    expect(made.nature).toBe("liability");
  });
});
