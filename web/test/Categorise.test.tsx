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
const api = { get: <T,>(p: string) => apiGet(p) as Promise<T> };

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

const searchFor = async (term: string) => {
  await userEvent.type(screen.getByLabelText("Merchant"), term);
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
};

beforeEach(() => apiGet.mockReset());

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
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("trims the term, so a stray space is not a different merchant", async () => {
    apiGet.mockResolvedValue({ transactions: [] });
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);

    await searchFor("  somemart  ");

    await waitFor(() => expect(apiGet.mock.calls[0][0]).toContain("q=somemart"));
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

    expect(apiGet).not.toHaveBeenCalled();
  });

  it("still says something when the failure is not an Error", async () => {
    // A rejected promise can carry anything. Reaching for `.message` on a
    // string would leave the screen blank under a spinner that had stopped.
    apiGet.mockResolvedValue({ transactions: [] });
    apiGet.mockImplementationOnce(async () => {
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
    // Once, over a resolving default. `mockRejectedValue` builds the rejected
    // promise when the mock is defined rather than when it is called, and the
    // runner reports it as unhandled before the component can attach a catch —
    // which reads as the component swallowing nothing when it handles it fine.
    apiGet.mockResolvedValue({ transactions: [] });
    apiGet.mockImplementationOnce(async () => {
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
    apiGet.mockResolvedValueOnce(two);
    const Categorise = await load();
    render(<Categorise api={api} {...RANGE} />);
    await searchFor("somemart");
    await waitFor(() => expect(screen.getByLabelText("Select SOMEMART 118")).toBeDefined());
    await userEvent.click(screen.getByLabelText("Select SOMEMART 118"));

    apiGet.mockResolvedValueOnce({ transactions: [tx({ dedupKey: "d9", description: "OTHERSHOP" })] });
    await userEvent.clear(screen.getByLabelText("Merchant"));
    await searchFor("othershop");

    await waitFor(() => expect(screen.getByText(/1 matching transaction, 1 selected/)).toBeDefined());
  });
});
