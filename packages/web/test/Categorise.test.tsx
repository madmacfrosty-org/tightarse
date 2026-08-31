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

describe("narrowing by type and amount", () => {
  const fill = async (fields: { term?: string; type?: string; min?: string; max?: string }) => {
    if (fields.term) await userEvent.type(screen.getByLabelText("Merchant"), fields.term);
    if (fields.type) await userEvent.selectOptions(screen.getByLabelText("Type"), fields.type);
    if (fields.min) await userEvent.type(screen.getByLabelText("Smallest amount"), fields.min);
    if (fields.max) await userEvent.type(screen.getByLabelText("Largest amount"), fields.max);
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
  };

  it("sends every condition, and they combine on the server", async () => {
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);

    await fill({ term: "somemart", type: "DIRECT_DEBIT", min: "90", max: "100" });

    await waitFor(() => expect(searches()).toHaveLength(1));
    const url = searches()[0]!;
    expect(url).toContain("q=somemart");
    expect(url).toContain("type=DIRECT_DEBIT");
    // Pounds on screen, pence on the wire.
    expect(url).toContain("min=9000");
    expect(url).toContain("max=10000");
  });

  it("searches on a type alone, with no merchant named", async () => {
    // The point of the filter: find the direct debits, then look at them.
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);

    await fill({ type: "STANDING_ORDER" });

    await waitFor(() => expect(searches()[0]).toContain("type=STANDING_ORDER"));
    expect(searches()[0]).not.toContain("q=");
  });

  it("searches on an amount alone", async () => {
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);

    await fill({ min: "1000" });

    await waitFor(() => expect(searches()[0]).toContain("min=100000"));
  });

  it("ignores an amount that is not one, and will not search on nothing else", async () => {
    // The server refuses a malformed bound outright; here it simply is not a
    // bound. What stops that becoming a search for the whole ledger is the
    // button staying disabled when nothing else was asked for.
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);

    await userEvent.type(screen.getByLabelText("Smallest amount"), "abc");

    expect(screen.getByRole("button", { name: "Search" })).toHaveProperty("disabled", true);
  });

  it("searches on the rest when only the amount is unusable", async () => {
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);

    await fill({ term: "somemart", min: "-5" });

    await waitFor(() => expect(searches()[0]).toContain("q=somemart"));
    expect(searches()[0]).not.toContain("min=");
  });

  it("will not search for nothing at all", async () => {
    // No conditions is the whole ledger, which is the dashboard's job.
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);

    expect(screen.getByRole("button", { name: "Search" })).toHaveProperty("disabled", true);
  });

  it.each([
    [{ min: "90", max: "100" }, /£90\.00–£100\.00/],
    [{ min: "90" }, /over £90\.00/],
    [{ max: "100" }, /under £100\.00/],
    [{ type: "DIRECT_DEBIT" }, /DIRECT_DEBIT/],
  ])("says what it searched for when nothing matches: %o", async (fields, expected) => {
    apiGet.mockImplementation(async (p: string) =>
      p.includes("/categories") ? { categories: [] } : { transactions: [] },
    );
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);

    await fill(fields);

    await waitFor(() => expect(screen.getByText(expected)).toBeDefined());
  });

  it("leaves out a bound that was not given", async () => {
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);

    await fill({ term: "somemart", min: "90" });

    await waitFor(() => expect(searches()[0]).toContain("min=9000"));
    expect(searches()[0]).not.toContain("max=");
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

describe("hiding what is already categorised", () => {
  const mixed = {
    transactions: [
      tx({ dedupKey: "d1", description: "SOMEMART 118" }),
      tx({ dedupKey: "d2", description: "SOMEMART 42", category: "groceries", setId: "built-in" }),
    ],
  };

  const searched = async () => {
    apiGet.mockImplementation(async (p: string) =>
      p.includes("/categories") ? { categories: [{ id: "fuel", label: "Fuel", kind: "spending" }] } : mixed,
    );
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);
    await searchFor("somemart");
    await waitFor(() => expect(screen.getByText("SOMEMART 118")).toBeDefined());
  };

  const toggle = () => screen.getByLabelText(/Show only what nothing has categorised/);

  it("shows everything until asked not to", async () => {
    await searched();

    expect(screen.getByText("SOMEMART 118")).toBeDefined();
    expect(screen.getByText("SOMEMART 42")).toBeDefined();
  });

  it("hides the ones a rule already claimed", async () => {
    // Uncategorised is not an empty category: the API reports the payment rail
    // marked provisional, and what it means is that no rule set answered.
    await searched();

    await userEvent.click(toggle());

    expect(screen.getByText("SOMEMART 118")).toBeDefined();
    expect(screen.queryByText("SOMEMART 42")).toBeNull();
  });

  it("leaves the selection alone, because the buttons act on the search", async () => {
    // Hiding rows and quietly deselecting them would disable the merchant
    // button exactly when somebody had found what they were looking for.
    await searched();

    await userEvent.click(toggle());

    expect(screen.getByText(/2 matching transactions, 2 selected, 1 hidden/)).toBeDefined();
  });

  it("keeps the merchant button available, since the rule is the search", async () => {
    await searched();
    await userEvent.selectOptions(screen.getByLabelText("Categorise as"), "fuel");

    await userEvent.click(toggle());

    expect(screen.getByRole("button", { name: "Categorise this merchant" })).toHaveProperty("disabled", false);
  });

  it("writes a rule for everything matched, not just what was on show", async () => {
    // The list is narrower than the rule's reach here, which is right: a
    // merchant rule takes that merchant whatever the rows are filed as now.
    apiPost.mockResolvedValue({
      prediction: {
        gained: { transactions: 1, outgoing: 0, merchants: 1, entries: [], truncated: false },
        lost: { transactions: 0, outgoing: 0, merchants: 0, entries: [], truncated: false },
        recategorised: { transactions: 1, outgoing: 0, merchants: 1, entries: [], truncated: false },
        unchanged: { transactions: 0, outgoing: 0, merchants: 0, entries: [], truncated: false },
        outranked: { transactions: 0, outgoing: 0, merchants: 0, entries: [], truncated: false },
        introducedConflicts: [],
        scanned: 2,
      },
    });
    await searched();
    await userEvent.selectOptions(screen.getByLabelText("Categorise as"), "fuel");
    await userEvent.click(toggle());

    await userEvent.click(screen.getByRole("button", { name: "Categorise this merchant" }));

    await waitFor(() => expect(screen.getByText("Before this is written")).toBeDefined());
    // The one it hid turns up here, as a recategorisation.
    expect(screen.getByText(/not just what is on screen/)).toBeDefined();
  });

  it("says nothing about hidden rows when none are", async () => {
    await searched();

    expect(screen.getByText(/2 matching transactions, 2 selected\./)).toBeDefined();
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

describe("adding a category", () => {
  const withCategories = async () => {
    apiGet.mockImplementation(async (p: string) =>
      p.includes("/categories") ? { categories: [{ id: "fuel", label: "Fuel", kind: "spending" }] } : { transactions: [tx()] },
    );
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);
    await userEvent.type(screen.getByLabelText("Merchant"), "somemart");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.getByLabelText("Categorise as")).toBeDefined());
  };

  it("offers a way to add one where you would have picked one", async () => {
    await withCategories();

    expect(screen.getByRole("option", { name: "New category…" })).toBeDefined();
  });

  it("creates it before it is used, and selects it", async () => {
    // Created first rather than folded into the proposal: a rule naming a
    // category that does not exist is refused, so one invented inside a
    // proposal would be previewed against a catalogue the apply would not use.
    apiPost.mockResolvedValue({ id: "season-ticket", label: "Season Ticket", kind: "spending" });
    await withCategories();

    await userEvent.selectOptions(screen.getByLabelText("Categorise as"), "new category");
    await userEvent.type(screen.getByLabelText("New category"), "Season Ticket");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith(pathFor("/categories"), {
      label: "Season Ticket",
      kind: "spending",
    }));
    await waitFor(() =>
      expect((screen.getByLabelText("Categorise as") as HTMLSelectElement).value).toBe("season-ticket"),
    );
  });

  it("puts it in the list, in order, so it can be picked again", async () => {
    apiPost.mockResolvedValue({ id: "aardvark", label: "Aardvark", kind: "spending" });
    await withCategories();

    await userEvent.selectOptions(screen.getByLabelText("Categorise as"), "new category");
    await userEvent.type(screen.getByLabelText("New category"), "Aardvark");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(screen.getByRole("option", { name: "Aardvark" })).toBeDefined());
    const labels = [...screen.getByLabelText("Categorise as").querySelectorAll("option")].map((o) => o.textContent);
    expect(labels.indexOf("Aardvark")).toBeLessThan(labels.indexOf("Fuel"));
  });

  it("defaults to spending, and takes the other two", async () => {
    apiPost.mockResolvedValue({ id: "savings", label: "Savings", kind: "movement" });
    await withCategories();

    await userEvent.selectOptions(screen.getByLabelText("Categorise as"), "new category");
    await userEvent.type(screen.getByLabelText("New category"), "Savings");
    expect((screen.getByLabelText("What it does to the money") as HTMLSelectElement).value).toBe("spending");

    await userEvent.selectOptions(screen.getByLabelText("What it does to the money"), "movement");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(apiPost.mock.calls[0][1]).toMatchObject({ kind: "movement" }));
  });

  it("will not add one with no name", async () => {
    await withCategories();

    await userEvent.selectOptions(screen.getByLabelText("Categorise as"), "new category");

    expect(screen.getByRole("button", { name: "Add" })).toHaveProperty("disabled", true);
  });

  it("says which category already has the name", async () => {
    // The sentence that tells you to pick that one instead of trying another
    // spelling.
    apiPost.mockImplementationOnce(async () => {
      throw new Error("“Eating Out” already uses the name eating-out");
    });
    await withCategories();

    await userEvent.selectOptions(screen.getByLabelText("Categorise as"), "new category");
    await userEvent.type(screen.getByLabelText("New category"), "eating out");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(screen.getByText(/already uses the name eating-out/)).toBeDefined());
  });

  it("leaves the form open after a refusal, so the name can be changed", async () => {
    apiPost.mockImplementationOnce(async () => {
      throw new Error("“Eating Out” already uses the name eating-out");
    });
    await withCategories();

    await userEvent.selectOptions(screen.getByLabelText("Categorise as"), "new category");
    await userEvent.type(screen.getByLabelText("New category"), "eating out");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(screen.getByText(/already uses/)).toBeDefined());
    expect(screen.getByLabelText("New category")).toBeDefined();
  });

  it("closes without adding anything on cancel", async () => {
    await withCategories();

    await userEvent.selectOptions(screen.getByLabelText("Categorise as"), "new category");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByLabelText("New category")).toBeNull();
    expect(apiPost).not.toHaveBeenCalled();
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

  it("writes a rule from the whole filter, not just the term", async () => {
    // The filter is the rule. A rule built from the term alone would take rows
    // the filters had hidden, and the screen would have lied about the button.
    apiPost.mockResolvedValue({ prediction });
    apiGet.mockImplementation(async (p: string) =>
      p.includes("/categories") ? { categories: [{ id: "bills", label: "Bills", kind: "spending" }] } : two,
    );
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);
    await userEvent.type(screen.getByLabelText("Merchant"), "somemart");
    await userEvent.selectOptions(screen.getByLabelText("Type"), "DIRECT_DEBIT");
    await userEvent.type(screen.getByLabelText("Smallest amount"), "90");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.getByLabelText("Categorise as")).toBeDefined());
    await userEvent.selectOptions(screen.getByLabelText("Categorise as"), "bills");

    await userEvent.click(screen.getByRole("button", { name: "Categorise this merchant" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(apiPost.mock.calls[0][1]).toEqual({
      merchant: { term: "somemart", type: "DIRECT_DEBIT", min: 9000, category: "bills" },
    });
  });

  it("writes what was searched, not what is currently typed", async () => {
    // Editing the boxes after a search must not silently change what the
    // button is about to write.
    apiPost.mockResolvedValue({ prediction });
    await ready();
    await userEvent.clear(screen.getByLabelText("Merchant"));
    await userEvent.type(screen.getByLabelText("Merchant"), "somethingelse");

    await userEvent.click(screen.getByRole("button", { name: "Categorise this merchant" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(apiPost.mock.calls[0][1]).toEqual({ merchant: { term: "somemart", category: "groceries" } });
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
