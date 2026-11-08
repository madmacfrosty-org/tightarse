import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Parses } from "../src/ports";
import { RuleSets, describeMatcher } from "../src/RuleSets";

/**
 * What is deciding the categories.
 *
 * Every pattern, category and note below is invented. This repository is
 * public, and a household's real rules are family names, an employer and the
 * people it pays regularly — which is exactly why they live in the table and
 * never in a file here.
 */

const apiGet = vi.fn(async (_p: string): Promise<unknown> => ({ sets: [], unreadable: 0 }));
const api = {
  get: <T,>(schema: Parses<T>, p: string) => apiGet(p).then((b: unknown) => schema.parse(b)),
  post: <T,>(_schema: Parses<T>, _p: string, _b: unknown) =>
    Promise.reject(new Error("this panel writes nothing")),
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

const withSets = (sets: unknown[], unreadable = 0) => {
  apiGet.mockImplementation(async () => ({ sets, unreadable }));
};

beforeEach(() => {
  vi.clearAllMocks();
  withSets([]);
});

describe("putting a matcher into words", () => {
  it("shows a pattern verbatim, and that it ignores case", () => {
    // A paraphrase of a regular expression is a lie somebody will act on.
    expect(describeMatcher({ kind: "merchant", pattern: "some.?mart" })).toBe(
      "description matches /some.?mart/i",
    );
  });

  it("names the bank's own category rather than ours", () => {
    expect(describeMatcher({ kind: "providerCategory", value: "DIRECT_DEBIT" })).toBe(
      'the bank\'s own category is "DIRECT_DEBIT"',
    );
  });

  it("does not pretend a dedup key is readable", () => {
    const said = describeMatcher({ kind: "transaction", dedupKey: "n:0123456789abcdef" });

    expect(said).toContain("one transaction");
    expect(said).toContain("89abcdef");
    // Enough to tell two overrides apart, not the whole hash dressed up as
    // information.
    expect(said).not.toContain("0123456789abcdef");
  });

  it("reads an amount range as money, not minor units", () => {
    expect(describeMatcher({ kind: "amount", min: 9000, max: 10000 })).toBe(
      "amount is between £90.00 and £100.00",
    );
  });

  it("says which end a one-sided range is open at", () => {
    expect(describeMatcher({ kind: "amount", min: 5000 })).toBe("amount is at least £50.00");
    expect(describeMatcher({ kind: "amount", max: 500 })).toBe("amount is at most £5.00");
  });

  it("joins the members of a conjunction with and", () => {
    expect(
      describeMatcher({
        kind: "all",
        of: [
          { kind: "merchant", pattern: "somemart" },
          { kind: "providerCategory", value: "PURCHASE" },
        ],
      }),
    ).toBe('description matches /somemart/i and the bank\'s own category is "PURCHASE"');
  });
});

describe("the sets", () => {
  it("says a set applies first, so precedence is readable without counting", async () => {
    withSets([set({ precedence: 0 })]);
    render(<RuleSets api={api} />);

    expect(await screen.findByText(/applies first/)).toBeDefined();
  });

  it("numbers a later set rather than calling it first", async () => {
    withSets([set({ setId: "a", precedence: 0 }), set({ setId: "b", name: "Shipped", precedence: 1 })]);
    render(<RuleSets api={api} />);

    expect(await screen.findByText(/applies 2nd/)).toBeDefined();
  });

  it("says plainly when a set applies to nothing", async () => {
    // A set sitting in the table is an offer, not an instruction, and no other
    // view says so. Somebody debugging a category needs telling.
    withSets([set({ setId: "offered", name: "Offered", adopted: false, precedence: undefined })]);
    render(<RuleSets api={api} />);

    expect(await screen.findByText(/not adopted/)).toBeDefined();
  });

  it("keeps the rules out of the way until asked", async () => {
    // Seventy-odd rules is not a screen anybody reads top to bottom.
    withSets([set()]);
    render(<RuleSets api={api} />);
    await screen.findByText(/This household/);

    expect(screen.queryByText(/somemart/)).toBeNull();
  });

  it("shows them when the set is opened", async () => {
    withSets([set()]);
    render(<RuleSets api={api} />);

    await userEvent.click(await screen.findByRole("button", { name: /This household/ }));

    expect(screen.getByText(/description matches \/somemart\/i/)).toBeDefined();
    expect(screen.getByText("groceries")).toBeDefined();
  });

  it("says which direction a rule applies to, since credits are the trap", async () => {
    // An employer sharing a name with a retailer once filed a year of salary
    // as Shopping. Direction is not a detail.
    withSets([set({ rules: [rule({ appliesTo: "credits" })] })]);
    render(<RuleSets api={api} />);

    await userEvent.click(await screen.findByRole("button", { name: /This household/ }));

    expect(screen.getByText("money in")).toBeDefined();
  });

  it("marks a refining rule apart from one that establishes a category", async () => {
    withSets([
      set({ rules: [rule({ contributes: { kind: "refine", category: "fuel" } })] }),
    ]);
    render(<RuleSets api={api} />);

    await userEvent.click(await screen.findByRole("button", { name: /This household/ }));

    expect(screen.getByText("fuel").className).toContain("provisional");
  });

  it("says a set is empty rather than showing an empty table", async () => {
    withSets([set({ rules: [] })]);
    render(<RuleSets api={api} />);

    await userEvent.click(await screen.findByRole("button", { name: /This household/ }));

    expect(screen.getByText(/No rules in this set/)).toBeDefined();
  });
});

describe("what it admits to", () => {
  it("reports sets it could not read rather than hiding them", async () => {
    // A set vanishing from this screen is how somebody concludes a rule was
    // deleted.
    withSets([set()], 2);
    render(<RuleSets api={api} />);

    expect(await screen.findByText(/2 stored sets could not be read/)).toBeDefined();
  });

  it("says nothing about unreadable sets when there are none", async () => {
    withSets([set()], 0);
    render(<RuleSets api={api} />);
    await screen.findByText(/This household/);

    expect(screen.queryByText(/could not be read/)).toBeNull();
  });

  it("says nothing is categorising when there are no sets at all", async () => {
    withSets([]);
    render(<RuleSets api={api} />);

    expect(await screen.findByText(/Nothing is categorising/)).toBeDefined();
  });

  it("reports a failure to read instead of an empty screen", async () => {
    apiGet.mockRejectedValue(new Error("the API said no"));
    render(<RuleSets api={api} />);

    expect(await screen.findByText("the API said no")).toBeDefined();
  });
});
