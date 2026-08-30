import { describe, it, expect } from "vitest";
import {
  adopt,
  isReservedTenant,
  SHARED_TENANT,
  orderedSets,
  Adoption,
  type Adoptions,
  precedenceOf,
  pinnedVersion,
} from "../src/categorisation/adoption.js";

const at = "2026-08-30T00:00:00.000Z";
const a = (setId: string, version = 1, supersedes?: string) => ({
  owner: "frost",
  setId,
  version,
  adoptedAt: at,
  ...(supersedes === undefined ? {} : { supersedes }),
});

describe("the shared catalogue", () => {
  it("is a tenant, so a shared set needs no home of its own", () => {
    // The whole simplification: a shared set is an ordinary rule set owned by a
    // tenant that is not a household, so the storage layout does not change.
    expect(isReservedTenant(SHARED_TENANT)).toBe(true);
  });

  it("does not claim a household's id", () => {
    expect(isReservedTenant("frost")).toBe(false);
    expect(isReservedTenant("")).toBe(false);
  });
});

describe("precedence is position", () => {
  it("ranks by index, most trusted first", () => {
    const adoptions: Adoptions = [
      a("overrides"),
      a("household"),
      a("built-in"),
    ];

    expect(precedenceOf(adoptions)).toEqual([
      { setId: "overrides", order: 0 },
      { setId: "household", order: 1 },
      { setId: "built-in", order: 2 },
    ]);
  });

  it("cannot produce two sets at the same rank", () => {
    // The bug this model removes. Precedence carried on the set let two sets
    // hold the same number, and equal ranks were broken by comparing ids —
    // deterministic, meaningless, and it had already chosen the wrong set.
    const orders = precedenceOf([
      a("provider"),
      a("provider-types"),
      a("built-in"),
    ]).map((p) => p.order);

    expect(new Set(orders).size).toBe(orders.length);
  });

  it("says nothing about a set that is not adopted", () => {
    expect(pinnedVersion([a("built-in", 4)], "built-in")).toBe(4);
    expect(pinnedVersion([a("built-in", 4)], "provider-types")).toBeUndefined();
  });
});

describe("what an adoption must carry", () => {
  it("refuses an empty set id or a non-positive version", () => {
    // A set id is the identity precedence is expressed against; an empty one
    // would rank something nothing can name.
    expect(Adoption.safeParse({ ...a("built-in"), setId: "" }).success).toBe(
      false,
    );
    expect(Adoption.safeParse({ ...a("built-in"), version: 0 }).success).toBe(
      false,
    );
    expect(Adoption.safeParse(a("built-in")).success).toBe(true);
  });

  it("treats supersedes as optional but never empty", () => {
    expect(
      Adoption.safeParse({ ...a("built-in"), supersedes: "" }).success,
    ).toBe(false);
    expect(
      Adoption.safeParse({ ...a("built-in"), supersedes: "provider" }).success,
    ).toBe(true);
  });
});

describe("adopting", () => {
  it("appends a set that replaces nothing", () => {
    const out = adopt([a("household")], a("built-in"));
    expect(out.map((x) => x.setId)).toEqual(["household", "built-in"]);
  });

  it("takes the position of the set it supersedes", () => {
    // Adopting a successor is not a statement about wanting it ranked
    // differently, so it inherits the place of what it replaced.
    const before: Adoptions = [a("overrides"), a("provider"), a("built-in")];
    const out = adopt(before, a("provider-types", 1, "provider"));

    expect(out.map((x) => x.setId)).toEqual([
      "overrides",
      "provider-types",
      "built-in",
    ]);
  });

  it("keeps the top position when superseding the most trusted set", () => {
    // Position 0 is the case an off-by-one hides: appending instead of
    // inserting would silently demote the replacement below everything, so a
    // corrections set replaced by a successor would stop winning.
    const before: Adoptions = [a("overrides"), a("household")];
    const out = adopt(before, a("overrides-v2", 1, "overrides"));

    expect(out.map((x) => x.setId)).toEqual(["overrides-v2", "household"]);
    expect(precedenceOf(out)[0]).toEqual({ setId: "overrides-v2", order: 0 });
  });

  it("removes the superseded set in the same step", () => {
    // In two steps there is a window where both compete, which is exactly the
    // state that hid a category behind a payment rail.
    const out = adopt([a("provider")], a("provider-types", 1, "provider"));

    expect(out.map((x) => x.setId)).toEqual(["provider-types"]);
    expect(out.some((x) => x.setId === "provider")).toBe(false);
  });

  it("re-adopting a set moves it rather than duplicating it", () => {
    const out = adopt([a("household"), a("built-in", 1)], a("built-in", 2));

    expect(out.map((x) => x.setId)).toEqual(["household", "built-in"]);
    expect(pinnedVersion(out, "built-in")).toBe(2);
  });

  it("supersedes a set that is not adopted, without inventing a position", () => {
    const out = adopt([a("household")], a("provider-types", 1, "provider"));
    expect(out.map((x) => x.setId)).toEqual(["household", "provider-types"]);
  });
});

describe("the sets a tenant actually uses", () => {
  const set = (setId: string, order: number) => ({ setId, order });

  it("falls back to the sets' own order when nothing is adopted", () => {
    // Every tenant today. Precedence is mid-migration from the set to the
    // adoption, and the fallback is what lets both exist without a data change.
    const out = orderedSets([], [set("built-in", 2), set("household", 0)]);
    expect(out.map((s) => s.setId)).toEqual(["household", "built-in"]);
  });

  it("keeps the fallback deterministic when two sets share an order", () => {
    // A data mistake, but the answer must not depend on the order a scan
    // returned them in, or the same ledger categorises differently twice.
    const a = orderedSets([], [set("bbb", 5), set("aaa", 5)]);
    const b = orderedSets([], [set("aaa", 5), set("bbb", 5)]);
    expect(a.map((s) => s.setId)).toEqual(b.map((s) => s.setId));
  });

  it("uses the adopted order once there is one, ignoring the sets' own", () => {
    const out = orderedSets(
      [a("built-in"), a("household")],
      [set("household", 0), set("built-in", 2)],
    );

    // Adopted order wins outright: built-in outranks household here because the
    // tenant said so, despite what the rows carry.
    expect(out.map((s) => s.setId)).toEqual(["built-in", "household"]);
  });

  it("leaves out a set that exists but was never adopted", () => {
    // Adoption is opt-in. A shared set sitting in the table is an offer, not an
    // instruction.
    const out = orderedSets(
      [a("household")],
      [set("household", 0), set("shared-merchants", 4)],
    );
    expect(out.map((s) => s.setId)).toEqual(["household"]);
  });

  it("ignores an adoption whose set is missing rather than failing", () => {
    const out = orderedSets([a("gone"), a("household")], [set("household", 0)]);
    expect(out.map((s) => s.setId)).toEqual(["household"]);
  });

  it("cannot express two sets at the same rank", () => {
    const out = orderedSets([a("x"), a("y")], [set("x", 9), set("y", 9)]);
    expect(out.map((s) => s.setId)).toEqual(["x", "y"]);
  });
});
