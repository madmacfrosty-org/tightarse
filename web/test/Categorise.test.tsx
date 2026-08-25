import { pathFor } from "@tightarse/api-contract";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Finding a merchant's transactions and choosing which to categorise.
 *
 * The property worth protecting is that what is on screen is what a rule would
 * take: debits only, matched by the server with the same matcher the rules
 * engine uses. A row shown here that a rule would decline, or one hidden that
 * it would take, is the screen lying about what the button is going to do.
 *
 * Merchants here are invented. Real ones are household data.
 */

const apiGet = vi.fn();
const apiPost = vi.fn();
const api = {
  get: <T,>(p: string) => apiGet(p) as Promise<T>,
  post: <T,>(p: string, b: unknown) => apiPost(p, b) as Promise<T>,
};

const tx = (over: Partial<Record<string, unknown>> = {}) => ({
  dedupKey: "d1",
  timestamp: "2026-03-05T00:00:00.000Z",
  amount: -12_50,
  currency: "GBP",
  description: "SOMEMART 118",
  accountId: "a1",
  transactionType: "DEBIT",
  category: "uncategorised",
  setId: "provider",
  ...over,
});

const load = async () => (await import("../src/Categorise")).Categorise;
const RANGE = { from: "2025-02-10", to: "2026-08-25" };

/** Only the transaction searches. The catalogue fetch on mount is not one. */
const searches = () => apiGet.mock.calls.map(([p]) => p as string).filter((p) => p.includes("/transactions"));

const searchFor = async (term: string) => {
  await userEvent.type(screen.getByLabelText("Merchant"), term);
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
};

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  // The screen asks for the category catalogue as it mounts. Without a default
  // every test has to answer a call it is not about, and one that forgets gets
  // an error message instead of the thing it is testing.
  apiGet.mockResolvedValue({ transactions: [], categories: [] });
});

describe("searching", () => {
  it("asks the server, which matches with the same matcher a rule uses", async () => {
    apiGet.mockResolvedValue({ transactions: [tx()] });
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);

    await searchFor("somemart");

    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(
        `${pathFor("/transactions")}?from=2025-02-10&to=2026-08-25&q=somemart`,
      ),
    );
  });

  it("will not search for nothing", async () => {
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);

    expect(screen.getByRole("button", { name: "Search" })).toHaveProperty("disabled", true);
    expect(searches()).toEqual([]);
  });

  it("trims the term, so a stray space is not a different merchant", async () => {
    apiGet.mockResolvedValue({ transactions: [] });
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);

    await searchFor("  somemart  ");

    await waitFor(() => expect(searches()[0]).toContain("q=somemart"));
  });

  it("does nothing when the form is submitted with nothing in the box", async () => {
    // The disabled button makes this hard to reach by clicking, which is a
    // convention rather than a guarantee — implicit submission differs between
    // browsers, and a form can be submitted outright. Submitted directly here
    // for that reason.
    const Categorise = await load();
    const { container } = render(<Categorise api={api} {...RANGE} />);

    fireEvent.submit(container.querySelector("form")!);
    await userEvent.type(screen.getByLabelText("Merchant"), "   ");
    fireEvent.submit(container.querySelector("form")!);

    expect(searches()).toEqual([]);
  });

  it("still says something when the failure is not an Error", async () => {
    // A rejected promise can carry anything. Reaching for `.message` on a
    // string would leave the screen blank under a spinner that had stopped.
    apiGet.mockImplementation(async (path: string) => {
      if (path.includes("/categories")) return { categories: [] };
      throw "gateway timeout";
    });
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);

    await searchFor("somemart");

    await waitFor(() => expect(screen.getByText("Search failed")).toBeDefined());
  });

  it("says so when nothing matches, rather than showing an empty table", async () => {
    apiGet.mockResolvedValue({ transactions: [] });
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);

    await searchFor("nothing");

    await waitFor(() => expect(screen.getByText(/Nothing matches/)).toBeDefined());
  });

  it("reports a failure instead of leaving the last results on screen", async () => {
    // By path, not by call order: the catalogue is fetched as the screen mounts,
    // so a `...Once` here would be spent on a call this test is not about.
    apiGet.mockImplementation(async (path: string) => {
      if (path.includes("/categories")) return { categories: [] };
      throw new Error("Service Unavailable");
    });
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);

    await searchFor("somemart");

    await waitFor(() => expect(screen.getByText("Service Unavailable")).toBeDefined());
  });
});

describe("what the list shows", () => {
  it("leaves out credits, because a refund is a question nobody asked", async () => {
    // The API searches both directions — direction is the rule's business — so
    // this is where the choice is made. A refund on screen next to a
    // debits-only rule is the screen promising something the rule declines.
    apiGet.mockResolvedValue({
      transactions: [tx(), tx({ dedupKey: "d2", description: "SOMEMART REFUND", amount: 9_99 })],
    });
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);

    await searchFor("somemart");

    await waitFor(() => expect(screen.getByText("SOMEMART 118")).toBeDefined());
    expect(screen.queryByText("SOMEMART REFUND")).toBeNull();
  });

  it("says it is debits only, so the limit is visible rather than mysterious", async () => {
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);

    expect(screen.getByText(/Debits only/)).toBeDefined();
  });

  it("counts what matched and what is selected", async () => {
    apiGet.mockResolvedValue({ transactions: [tx(), tx({ dedupKey: "d2" })] });
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);

    await searchFor("somemart");

    await waitFor(() => expect(screen.getByText(/2 matching transactions, 2 selected/)).toBeDefined());
  });

  it("shows the category a transaction already has", async () => {
    apiGet.mockResolvedValue({ transactions: [tx({ category: "groceries", setId: "built-in" })] });
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);

    await searchFor("somemart");

    await waitFor(() => expect(screen.getByText("groceries")).toBeDefined());
  });
});

describe("a long list", () => {
  const many = {
    transactions: Array.from({ length: 60 }, (_, i) =>
      tx({ dedupKey: `d${i}`, description: `SOMEMART ${i}` }),
    ),
  };

  it("caps what it renders, because a phone feels every row", async () => {
    apiGet.mockResolvedValue(many);
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);

    await searchFor("somemart");

    await waitFor(() => expect(screen.getByText("SOMEMART 0")).toBeDefined());
    expect(screen.queryByText("SOMEMART 55")).toBeNull();
    // A cap on rendering, not on the answer: all sixty are matched and selected.
    expect(screen.getByText(/60 matching transactions, 60 selected/)).toBeDefined();
  });

  it("shows the rest on request", async () => {
    apiGet.mockResolvedValue(many);
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);
    await searchFor("somemart");
    await waitFor(() => expect(screen.getByRole("button", { name: /Show 10 more/ })).toBeDefined());

    await userEvent.click(screen.getByRole("button", { name: /Show 10 more/ }));

    expect(screen.getByText("SOMEMART 55")).toBeDefined();
  });
});

describe("choosing", () => {
  const two = { transactions: [tx(), tx({ dedupKey: "d2", description: "SOMEMART 42" })] };

  it("starts with everything selected, because categorising the lot is the case", async () => {
    apiGet.mockResolvedValue(two);
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);

    await searchFor("somemart");

    await waitFor(() => expect(screen.getByLabelText("Select SOMEMART 118")).toHaveProperty("checked", true));
    expect(screen.getByLabelText("Select SOMEMART 42")).toHaveProperty("checked", true);
  });

  it("unticks one without disturbing the others", async () => {
    apiGet.mockResolvedValue(two);
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);
    await searchFor("somemart");
    await waitFor(() => expect(screen.getByLabelText("Select SOMEMART 118")).toBeDefined());

    await userEvent.click(screen.getByLabelText("Select SOMEMART 118"));

    expect(screen.getByLabelText("Select SOMEMART 118")).toHaveProperty("checked", false);
    expect(screen.getByLabelText("Select SOMEMART 42")).toHaveProperty("checked", true);
    expect(screen.getByText(/2 matching transactions, 1 selected/)).toBeDefined();
  });

  it("puts one back after taking it out", async () => {
    apiGet.mockResolvedValue(two);
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);
    await searchFor("somemart");
    await waitFor(() => expect(screen.getByLabelText("Select SOMEMART 118")).toBeDefined());

    await userEvent.click(screen.getByLabelText("Select SOMEMART 118"));
    await userEvent.click(screen.getByLabelText("Select SOMEMART 118"));

    expect(screen.getByLabelText("Select SOMEMART 118")).toHaveProperty("checked", true);
    expect(screen.getByText(/2 matching transactions, 2 selected/)).toBeDefined();
  });

  it("clears and restores the whole selection from the header", async () => {
    apiGet.mockResolvedValue(two);
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);
    await searchFor("somemart");
    await waitFor(() => expect(screen.getByLabelText("Deselect all")).toBeDefined());

    await userEvent.click(screen.getByLabelText("Deselect all"));
    expect(screen.getByText(/2 matching transactions, 0 selected/)).toBeDefined();

    await userEvent.click(screen.getByLabelText("Select all"));
    expect(screen.getByText(/2 matching transactions, 2 selected/)).toBeDefined();
  });

  it("starts a fresh search with a fresh selection", async () => {
    let answer = two;
    apiGet.mockImplementation(async (path: string) =>
      path.includes("/categories") ? { categories: [] } : answer,
    );
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);
    await searchFor("somemart");
    await waitFor(() => expect(screen.getByLabelText("Select SOMEMART 118")).toBeDefined());
    await userEvent.click(screen.getByLabelText("Select SOMEMART 118"));

    answer = { transactions: [tx({ dedupKey: "d9", description: "OTHERSHOP" })] };
    await userEvent.clear(screen.getByLabelText("Merchant"));
    await searchFor("othershop");

    await waitFor(() => expect(screen.getByText(/1 matching transaction, 1 selected/)).toBeDefined());
  });
});

describe("proposing", () => {
  const two = { transactions: [tx(), tx({ dedupKey: "d2", description: "SOMEMART 42" })] };
  const prediction = {
    gained: { transactions: 40, outgoing: 0, merchants: 1, entries: [], truncated: false },
    lost: { transactions: 0, outgoing: 0, merchants: 0, entries: [], truncated: false },
    recategorised: { transactions: 3, outgoing: 0, merchants: 1, entries: [], truncated: false },
    unchanged: { transactions: 1, outgoing: 0, merchants: 1, entries: [], truncated: false },
    outranked: { transactions: 0, outgoing: 0, merchants: 0, entries: [], truncated: false },
    introducedConflicts: [],
    scanned: 44,
  };

  const ready = async () => {
    apiGet.mockImplementation(async (p: string) =>
      p.includes("/categories") ? { categories: [{ id: "groceries", label: "Groceries", kind: "spending" }] } : two,
    );
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);
    await searchFor("somemart");
    await waitFor(() => expect(screen.getByLabelText("Select SOMEMART 118")).toBeDefined());
    await userEvent.selectOptions(screen.getByLabelText("Categorise as"), "groceries");
  };

  it("offers the categories the API says exist, by label", async () => {
    await ready();

    expect(screen.getByRole("option", { name: "Groceries" })).toBeDefined();
  });

  it("asks what a merchant rule would do before writing one", async () => {
    apiPost.mockResolvedValue({ prediction });
    await ready();

    await userEvent.click(screen.getByRole("button", { name: "Categorise this merchant" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const [path, body] = apiPost.mock.calls[0];
    // The term, not a pattern. Escaping happens once, on the server, by the
    // same function that built the search which found these rows.
    expect(path).toContain("commit=preview");
    expect(body).toEqual({ merchant: { term: "somemart", category: "groceries" } });
  });

  it("shows what it would do, measured against the whole ledger", async () => {
    apiPost.mockResolvedValue({ prediction });
    await ready();

    await userEvent.click(screen.getByRole("button", { name: "Categorise this merchant" }));

    await waitFor(() => expect(screen.getByText("Before this is written")).toBeDefined());
    expect(screen.getByText("40")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
    expect(screen.getByText(/not just what is on screen/)).toBeDefined();
  });

  it("writes nothing until it is confirmed", async () => {
    apiPost.mockResolvedValue({ prediction });
    await ready();

    await userEvent.click(screen.getByRole("button", { name: "Categorise this merchant" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm" })).toBeDefined());

    expect(apiPost.mock.calls.every(([p]) => (p as string).includes("commit=preview"))).toBe(true);
  });

  it("applies on confirm, and asks the ledger again rather than patching the screen", async () => {
    apiPost.mockResolvedValueOnce({ prediction });
    apiPost.mockResolvedValueOnce({ prediction, applied: { scanned: 44, unchanged: 1, appended: 43, orphaned: 0, uncategorised: 0, conflicts: 0, inertRefines: 0 } });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Categorise this merchant" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm" })).toBeDefined());
    const before = searches().length;

    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(screen.getByText(/43 categorised/)).toBeDefined());
    expect(apiPost.mock.calls[1][0]).toContain("commit=apply");
    expect(searches().length).toBeGreaterThan(before);
  });

  it("abandons a proposal on cancel, having written nothing", async () => {
    apiPost.mockResolvedValue({ prediction });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Categorise this merchant" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeDefined());

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Before this is written")).toBeNull();
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it("names the selected transactions rather than a pattern, when that is the button", async () => {
    apiPost.mockResolvedValue({ prediction });
    await ready();
    await userEvent.click(screen.getByLabelText("Select SOMEMART 42"));

    await userEvent.click(screen.getByRole("button", { name: /Categorise 1 selected/ }));

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(apiPost.mock.calls[0][1]).toEqual({ transactions: { dedupKeys: ["d1"], category: "groceries" } });
  });

  it("counts the selection in the button, singular and plural", async () => {
    apiPost.mockResolvedValue({ prediction });
    await ready();

    expect(screen.getByRole("button", { name: /Categorise 2 selected/ })).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: /Categorise 2 selected/ }));

    await waitFor(() => expect(screen.getByText(/Categorising 2 transactions/)).toBeDefined());
  });

  it("says nothing was categorised when applying reports nothing", async () => {
    // A response without a report is not a crash and not a silent success.
    apiPost.mockResolvedValueOnce({ prediction });
    apiPost.mockResolvedValueOnce({ prediction });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Categorise this merchant" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm" })).toBeDefined());

    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(screen.getByText(/0 categorised/)).toBeDefined());
  });

  it("will not propose a merchant rule while a match is unticked", async () => {
    // The rule would take the row that was put back, so the screen would have
    // shown one thing and the rule done another.
    await ready();
    await userEvent.click(screen.getByLabelText("Select SOMEMART 42"));

    expect(screen.getByRole("button", { name: "Categorise this merchant" })).toHaveProperty("disabled", true);
  });

  it("will not propose anything without a category", async () => {
    apiGet.mockImplementation(async (p: string) =>
      p.includes("/categories") ? { categories: [{ id: "groceries", label: "Groceries", kind: "spending" }] } : two,
    );
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);
    await searchFor("somemart");
    await waitFor(() => expect(screen.getByLabelText("Categorise as")).toBeDefined());

    expect(screen.getByRole("button", { name: "Categorise this merchant" })).toHaveProperty("disabled", true);
  });

  it("says when a proposal would make a set contradict itself", async () => {
    apiPost.mockResolvedValue({
      prediction: { ...prediction, introducedConflicts: [{ setId: "household", categories: ["a", "b"], transactions: 2, example: "SOMEMART 118" }] },
    });
    await ready();

    await userEvent.click(screen.getByRole("button", { name: "Categorise this merchant" }));

    await waitFor(() => expect(screen.getByText(/claim two answers at once/)).toBeDefined());
  });

  it("says something when applying fails with no message to show", async () => {
    apiPost.mockResolvedValueOnce({ prediction });
    apiPost.mockImplementationOnce(async () => {
      throw "gateway timeout";
    });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Categorise this merchant" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm" })).toBeDefined());

    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(screen.getByText("Could not apply that")).toBeDefined());
  });

  it("reports a refusal from the API instead of a blank panel", async () => {
    apiGet.mockImplementation(async (p: string) =>
      p.includes("/categories") ? { categories: [{ id: "groceries", label: "Groceries", kind: "spending" }] } : two,
    );
    apiPost.mockImplementationOnce(async () => {
      throw new Error("sets.0.order: Expected number");
    });
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);
    await searchFor("somemart");
    await waitFor(() => expect(screen.getByLabelText("Categorise as")).toBeDefined());
    await userEvent.selectOptions(screen.getByLabelText("Categorise as"), "groceries");

    await userEvent.click(screen.getByRole("button", { name: "Categorise this merchant" }));

    await waitFor(() => expect(screen.getByText("sets.0.order: Expected number")).toBeDefined());
  });
});
