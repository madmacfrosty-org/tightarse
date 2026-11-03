import { describe, it, expect, vi, beforeEach } from "vitest";
import { ruleSets } from "../src/index.js";

/**
 * Reading the rules as they stand.
 *
 * The two things worth testing hardest are both about honesty rather than
 * features: that an unadopted set is reported as applying to nothing, and that
 * a set which cannot be read is counted rather than quietly dropped. Both are
 * cases where showing the convenient thing would mislead somebody trying to
 * work out why a transaction has the category it has.
 */

const listRuleSets = vi.fn();
const getAdoptions = vi.fn();
const deps = { ledger: { listRuleSets, getAdoptions } };

const set = (setId: string, over: Record<string, unknown> = {}) => ({
  setId,
  version: 1,
  name: setId,
  authored: false,
  rules: [],
  status: "effective",
  createdAt: "2026-08-27T00:00:00.000Z",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  getAdoptions.mockResolvedValue([]);
});

describe("the order the sets apply in", () => {
  // Precedence comes from the household's adoption list, never from anything on
  // a set. A set carries no rank and cannot: one shared between households
  // ranks differently for each, so where it sits is a property of the decision
  // to use it. #121.
  it("puts adopted sets first, in the order they apply", async () => {
    listRuleSets.mockResolvedValue([set("built-in"), set("overrides"), set("household")]);
    getAdoptions.mockResolvedValue([
      { setId: "overrides" },
      { setId: "household" },
      { setId: "built-in" },
    ]);

    const { sets } = await ruleSets(deps, "frost");

    expect(sets.map((s) => s.setId)).toEqual(["overrides", "household", "built-in"]);
    expect(sets.map((s) => s.precedence)).toEqual([0, 1, 2]);
  });

  it("lists an unadopted set after the adopted ones, and says it is unadopted", async () => {
    // A shared set sitting in the table is an offer, not an instruction. No
    // other view says so, and somebody debugging a category needs telling.
    listRuleSets.mockResolvedValue([set("household"), set("offered")]);
    getAdoptions.mockResolvedValue([{ setId: "household" }]);

    const { sets } = await ruleSets(deps, "frost");

    expect(sets.map((s) => [s.setId, s.adopted])).toEqual([
      ["household", true],
      ["offered", false],
    ]);
  });

  it("gives an unadopted set no precedence rather than a sentinel", async () => {
    listRuleSets.mockResolvedValue([set("offered")]);

    const { sets } = await ruleSets(deps, "frost");

    expect(sets[0]?.adopted).toBe(false);
    expect(sets[0]).not.toHaveProperty("precedence");
  });

  it("orders unadopted sets by id, so two reads do not reorder the screen", async () => {
    listRuleSets.mockResolvedValue([set("zeta"), set("alpha"), set("middle")]);

    const { sets } = await ruleSets(deps, "frost");

    expect(sets.map((s) => s.setId)).toEqual(["alpha", "middle", "zeta"]);
  });

  it("returns nothing adopted when the household has adopted nothing", async () => {
    // A tenant that has adopted nothing categorises nothing. That is the
    // model, and this screen should show it rather than imply an order.
    listRuleSets.mockResolvedValue([set("household"), set("built-in")]);

    const { sets } = await ruleSets(deps, "frost");

    expect(sets.every((s) => s.adopted === false)).toBe(true);
  });
});

describe("what each set reports", () => {
  it("carries the rules through whole", async () => {
    const rule = {
      matcher: { kind: "merchant", pattern: "somemart" },
      contributes: { kind: "assert", category: "groceries" },
      appliesTo: "debits",
      note: "the big one",
    };
    listRuleSets.mockResolvedValue([set("household", { rules: [rule], authored: true })]);
    getAdoptions.mockResolvedValue([{ setId: "household" }]);

    const { sets } = await ruleSets(deps, "frost");

    expect(sets[0]?.rules).toEqual([rule]);
    expect(sets[0]?.authored).toBe(true);
  });

  it("reports the version in force and who made it", async () => {
    listRuleSets.mockResolvedValue([
      set("household", { version: 14, createdBy: "someone@example.invalid" }),
    ]);
    getAdoptions.mockResolvedValue([{ setId: "household" }]);

    const { sets } = await ruleSets(deps, "frost");

    expect(sets[0]?.version).toBe(14);
    expect(sets[0]?.createdBy).toBe("someone@example.invalid");
  });

  it("omits an author nobody recorded", async () => {
    listRuleSets.mockResolvedValue([set("household")]);

    const { sets } = await ruleSets(deps, "frost");

    expect(sets[0]).not.toHaveProperty("createdBy");
  });

  it("reports a proposed set as proposed rather than hiding it", async () => {
    // A version awaiting a decision is the thing somebody came here to find.
    listRuleSets.mockResolvedValue([set("household", { status: "proposed" })]);

    const { sets } = await ruleSets(deps, "frost");

    expect(sets[0]?.status).toBe("proposed");
  });
});

describe("a set that cannot be read", () => {
  it("is left out and counted, not silently dropped", async () => {
    // Leaving it out matches what application does — a malformed set matches
    // nothing. Counting it is the difference between "these are your rules"
    // and somebody concluding a rule was deleted.
    listRuleSets.mockResolvedValue([set("household"), { setId: "broken" }]);

    const { sets, unreadable } = await ruleSets(deps, "frost");

    expect(sets.map((s) => s.setId)).toEqual(["household"]);
    expect(unreadable).toBe(1);
  });

  it("counts nothing when every set reads", async () => {
    listRuleSets.mockResolvedValue([set("household")]);

    expect((await ruleSets(deps, "frost")).unreadable).toBe(0);
  });

  it("does not count an unreadable set as adopted even when the list names it", async () => {
    // The adoption names a set that will not parse. It cannot appear, so it
    // must not take a precedence slot and shift the ones that can.
    listRuleSets.mockResolvedValue([{ setId: "broken" }, set("household")]);
    getAdoptions.mockResolvedValue([{ setId: "broken" }, { setId: "household" }]);

    const { sets, unreadable } = await ruleSets(deps, "frost");

    expect(sets.map((s) => [s.setId, s.precedence])).toEqual([["household", 0]]);
    expect(unreadable).toBe(1);
  });
});

describe("an empty household", () => {
  it("answers with nothing rather than failing", async () => {
    listRuleSets.mockResolvedValue([]);

    expect(await ruleSets(deps, "frost")).toEqual({ sets: [], unreadable: 0 });
  });
});
