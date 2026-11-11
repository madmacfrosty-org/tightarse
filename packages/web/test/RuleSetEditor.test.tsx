import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Parses } from "../src/ports";
import { RuleSets } from "../src/RuleSets";

/**
 * Editing a set's rules.
 *
 * Every pattern, category and note below is invented. This repository is
 * public, and a household's real rules are family names and the people it pays.
 *
 * Driven through `RuleSets` rather than the editor alone, because the thing
 * worth protecting is the whole path: which sets offer editing at all, that
 * nothing is written before a preview, and that what is confirmed is what was
 * previewed.
 */

const RANGE = { from: "2026-01-01", to: "2026-12-31" };

const CATEGORIES = [
  { id: "groceries", label: "Groceries", nature: "expense" },
  { id: "fuel", label: "Fuel", nature: "expense" },
];

const apiGet = vi.fn(async (_p: string): Promise<unknown> => ({ sets: [], unreadable: 0 }));
const apiPost = vi.fn(async (_p: string, _b: unknown): Promise<unknown> => ({
  prediction: {
    gained: { transactions: 3, outgoing: 0, merchants: 0, entries: [], truncated: false },
    lost: { transactions: 0, outgoing: 0, merchants: 0, entries: [], truncated: false },
    recategorised: { transactions: 1, outgoing: 0, merchants: 0, entries: [], truncated: false },
    unchanged: { transactions: 9, outgoing: 0, merchants: 0, entries: [], truncated: false },
    outranked: { transactions: 0, outgoing: 0, merchants: 0, entries: [], truncated: false },
    introducedConflicts: [],
    scanned: 13,
  },
  applied: {
    scanned: 13,
    unchanged: 9,
    appended: 4,
    orphaned: 0,
    uncategorised: 0,
    conflicts: 0,
    inertRefines: 0,
  },
}));

const api = {
  get: <T,>(schema: Parses<T>, p: string) => apiGet(p).then((b: unknown) => schema.parse(b)),
  post: <T,>(schema: Parses<T>, p: string, b: unknown) =>
    apiPost(p, b).then((r: unknown) => schema.parse(r)),
};

const rule = (over: Record<string, unknown> = {}) => ({
  matcher: { kind: "merchant", pattern: "somemart" },
  contributes: { kind: "assert", category: "groceries" },
  appliesTo: "debits",
  ...over,
});

const set = (over: Record<string, unknown> = {}) => ({
  setId: "household",
  name: "This household",
  version: 14,
  status: "effective",
  authored: true,
  adopted: true,
  precedence: 0,
  rules: [rule()],
  createdAt: "2026-08-27T00:00:00.000Z",
  ...over,
});

const withSets = (sets: unknown[]) => {
  apiGet.mockImplementation(async (p: string) =>
    p.includes("/categorisation/rules")
      ? { sets, unreadable: 0 }
      : { categories: CATEGORIES },
  );
};

const open = async (name = /This household/) => {
  render(<RuleSets api={api} range={RANGE} />);
  await userEvent.click(await screen.findByRole("button", { name }));
};

const edit = async () => {
  await open();
  await userEvent.click(screen.getByRole("button", { name: /Edit these rules/ }));
};

const sent = () => apiPost.mock.calls.at(-1)!;
const body = () => sent()[1] as { sets: Record<string, unknown>[]; because: string };

beforeEach(() => {
  vi.clearAllMocks();
  withSets([set()]);
});

describe("which sets may be edited", () => {
  it("offers editing on a set somebody wrote", async () => {
    await open();

    expect(screen.getByRole("button", { name: /Edit these rules/ })).toBeDefined();
  });

  it("refuses a generated set, and says why rather than just hiding the button", async () => {
    // `authored` means never regenerated. Editing one that is rebuilt is work
    // that disappears silently at a time nobody chose, so saying so beats a
    // missing button somebody assumes is a bug.
    withSets([set({ setId: "built-in", name: "Shipped patterns", authored: false })]);
    await open(/Shipped patterns/);

    expect(screen.queryByRole("button", { name: /Edit these rules/ })).toBeNull();
    expect(screen.getByText(/would disappear the next time it is regenerated/)).toBeDefined();
  });
});

describe("staging a change", () => {
  it("writes nothing until a preview has been asked for", async () => {
    await edit();
    await userEvent.clear(screen.getByLabelText("Pattern for rule 0"));
    await userEvent.type(screen.getByLabelText("Pattern for rule 0"), "othermart");

    expect(apiPost).not.toHaveBeenCalled();
  });

  it("will not review until something has actually changed", async () => {
    await edit();

    expect(screen.getByRole("button", { name: /Review change/ })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByText(/Nothing changed yet/)).toBeDefined();
  });

  it("sends the edited pattern, and the version it read", async () => {
    // The version is what makes a stale edit fail instead of silently putting
    // somebody else's change back.
    await edit();
    await userEvent.clear(screen.getByLabelText("Pattern for rule 0"));
    await userEvent.type(screen.getByLabelText("Pattern for rule 0"), "othermart");
    await userEvent.click(screen.getByRole("button", { name: /Review change/ }));

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(body().sets[0]).toMatchObject({ setId: "household", version: 14 });
    expect((body().sets[0]!["rules"] as Record<string, unknown>[])[0]).toMatchObject({
      matcher: { kind: "merchant", pattern: "othermart" },
    });
  });

  it("asks what it would do before writing, never applying straight off", async () => {
    await edit();
    await userEvent.clear(screen.getByLabelText("Pattern for rule 0"));
    await userEvent.type(screen.getByLabelText("Pattern for rule 0"), "othermart");
    await userEvent.click(screen.getByRole("button", { name: /Review change/ }));

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(sent()[0]).toContain("commit=preview");
  });

  it("changes a category", async () => {
    await edit();
    await userEvent.selectOptions(screen.getByLabelText("Category for rule 0"), "fuel");
    await userEvent.click(screen.getByRole("button", { name: /Review change/ }));

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect((body().sets[0]!["rules"] as Record<string, unknown>[])[0]).toMatchObject({
      contributes: { kind: "assert", category: "fuel" },
    });
  });

  it("changes which direction a rule applies to", async () => {
    await edit();
    await userEvent.selectOptions(screen.getByLabelText("Direction for rule 0"), "all");
    await userEvent.click(screen.getByRole("button", { name: /Review change/ }));

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect((body().sets[0]!["rules"] as Record<string, unknown>[])[0]).toMatchObject({
      appliesTo: "all",
    });
  });

  it("deletes a rule", async () => {
    withSets([set({ rules: [rule(), rule({ matcher: { kind: "merchant", pattern: "other" } })] })]);
    await edit();
    await userEvent.click(screen.getByLabelText("Delete rule 0"));
    await userEvent.click(screen.getByRole("button", { name: /Review change/ }));

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const rules = body().sets[0]!["rules"] as Record<string, unknown>[];
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ matcher: { kind: "merchant", pattern: "other" } });
  });

  it("reorders, because order decides which of two matching rules wins", async () => {
    withSets([
      set({
        rules: [rule({ matcher: { kind: "merchant", pattern: "first" } }), rule({ matcher: { kind: "merchant", pattern: "second" } })],
      }),
    ]);
    await edit();
    await userEvent.click(screen.getByLabelText("Move rule 1 earlier"));
    await userEvent.click(screen.getByRole("button", { name: /Review change/ }));

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const rules = body().sets[0]!["rules"] as Record<string, unknown>[];
    expect(rules.map((r) => (r["matcher"] as { pattern: string }).pattern)).toEqual([
      "second",
      "first",
    ]);
  });

  it("cannot move the first rule earlier or the last later", async () => {
    await edit();

    expect(screen.getByLabelText("Move rule 0 earlier")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Move rule 0 later")).toHaveProperty("disabled", true);
  });

  it("drops an emptied note rather than sending an empty string", async () => {
    withSets([set({ rules: [rule({ note: "the big one" })] })]);
    await edit();
    await userEvent.clear(screen.getByLabelText("Note for rule 0"));
    await userEvent.click(screen.getByRole("button", { name: /Review change/ }));

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect((body().sets[0]!["rules"] as Record<string, unknown>[])[0]).not.toHaveProperty("note");
  });
});

describe("what it will not let you edit", () => {
  it("shows a matcher it cannot safely change, without an input", async () => {
    // Five shapes with their own validity rules. A half-built editor for them
    // is a way to write a set that will not parse.
    withSets([set({ rules: [rule({ matcher: { kind: "amount", min: 9000, max: 10000 } })] })]);
    await edit();

    expect(screen.getByText(/amount is between £90.00 and £100.00/)).toBeDefined();
    expect(screen.queryByLabelText("Pattern for rule 0")).toBeNull();
  });

  it("still lets its category and direction be fixed", async () => {
    withSets([set({ rules: [rule({ matcher: { kind: "transaction", dedupKey: "n:abc12345" } })] })]);
    await edit();

    expect(screen.getByLabelText("Category for rule 0")).toBeDefined();
    expect(screen.getByLabelText("Direction for rule 0")).toBeDefined();
  });
});

describe("the category list", () => {
  it("keeps a retired category the rule already names", async () => {
    // Otherwise opening the editor would silently repoint the rule at whatever
    // the dropdown happened to show first.
    withSets([set({ rules: [rule({ contributes: { kind: "assert", category: "gone" } })] })]);
    await edit();

    expect(screen.getByText("gone (retired)")).toBeDefined();
  });
});

describe("applying it", () => {
  const stage = async () => {
    await edit();
    await userEvent.selectOptions(screen.getByLabelText("Category for rule 0"), "fuel");
    await userEvent.click(screen.getByRole("button", { name: /Review change/ }));
    await screen.findByText(/Before this is written/);
  };

  it("shows what it would do", async () => {
    await stage();

    expect(screen.getByText(/Changing 1 rule in This household/)).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
  });

  it("writes only on confirming, and says apply", async () => {
    await stage();
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(sent()[0]).toContain("commit=apply"));
  });

  it("confirms exactly what was previewed", async () => {
    // The body is held rather than rebuilt, so a re-render between preview and
    // confirm cannot change what is written.
    await stage();
    const previewed = JSON.stringify(body());
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(body())).toBe(previewed);
  });

  it("re-reads the rules afterwards rather than patching the screen", async () => {
    await stage();
    const readsBefore = apiGet.mock.calls.filter(([p]) =>
      p.includes("/categorisation/rules"),
    ).length;
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(
        apiGet.mock.calls.filter(([p]) => p.includes("/categorisation/rules")).length,
      ).toBeGreaterThan(readsBefore),
    );
  });

  it("abandons the change on cancel, writing nothing more", async () => {
    await stage();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText(/Before this is written/)).toBeNull();
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it("reports a refusal, so a stale edit says what happened", async () => {
    // The 409 from the server when somebody else has changed the set. Its
    // message names both versions, and showing it verbatim is the only way the
    // reader learns to re-read rather than retry.
    await edit();
    await userEvent.selectOptions(screen.getByLabelText("Category for rule 0"), "fuel");
    apiPost.mockRejectedValueOnce(
      new Error("These rule sets changed since they were read: household (read 14, now 15)"),
    );
    await userEvent.click(screen.getByRole("button", { name: /Review change/ }));

    expect(await screen.findByText(/household \(read 14, now 15\)/)).toBeDefined();
  });
});

describe("emptying a set", () => {
  it("warns that nothing will be categorised by it", async () => {
    await edit();
    await userEvent.click(screen.getByLabelText("Delete rule 0"));

    expect(screen.getByText(/Every rule removed/)).toBeDefined();
  });
});
