import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

/**
 * Every book on screen.
 *
 * The property worth protecting is the split: what the household is worth,
 * separately from what has passed through it. A panel that listed all of them
 * together would put a year's groceries next to a current account and invite
 * adding them up.
 *
 * Every figure and label is invented.
 */

const apiGet = vi.fn();
const api = {
  get: <T,>(p: string) => apiGet(p) as Promise<T>,
  post: <T,>(_p: string, b: unknown) => Promise.resolve(b as T),
};

const response = {
  householdPosition: -178_000_00,
  books: [
    { book: "cur", label: "Main Account", nature: "asset", rollsUp: true, position: 2_000_00 },
    { book: "card", label: "Blue card", nature: "liability", rollsUp: true, position: -500_00 },
    { book: "mortgage", label: "Mortgage", nature: "liability", rollsUp: true, position: -179_500_00 },
    { book: "groceries", label: "Groceries", nature: "expense", rollsUp: false, position: 12_450_00 },
  ],
};

const load = async () => (await import("../src/Books")).Books;

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockResolvedValue(response);
});

describe("every book", () => {
  it("states the household's position from the books that roll up", async () => {
    const Books = await load();
    render(<Books api={api} />);
    await waitFor(() => screen.getByText(/Household position/));
    expect(screen.getByText(/Household position: −£178,000.00/)).toBeDefined();
  });

  it("puts a loan among what the household is worth, not among what it spent", async () => {
    // The reason `liability` exists. A mortgage is not an expense: it is a
    // position, and repaying it moves nothing.
    const Books = await load();
    render(<Books api={api} />);
    await waitFor(() => screen.getByText("Mortgage"));
    const worth = screen.getByLabelText("What the household is worth");
    expect(worth.textContent).toContain("Mortgage");
    expect(worth.textContent).toContain("−£179,500.00");
  });

  it("keeps spending out of what the household is worth", async () => {
    const Books = await load();
    render(<Books api={api} />);
    await waitFor(() => screen.getByText("Groceries"));
    const worth = screen.getByLabelText("What the household is worth");
    expect(worth.textContent).not.toContain("Groceries");
    expect(
      screen.getByLabelText("What has passed through").textContent,
    ).toContain("Groceries");
  });

  it("shows a card and a loan the same way, because they are the same thing", async () => {
    const Books = await load();
    render(<Books api={api} />);
    await waitFor(() => screen.getByText("Blue card"));
    expect(screen.getByText("−£500.00")).toBeDefined();
    expect(screen.getAllByText("liability").length).toBe(2);
  });

  it("says so when it cannot load them, rather than rendering an empty table", async () => {
    apiGet.mockRejectedValue(new Error("nope"));
    const Books = await load();
    render(<Books api={api} />);
    await waitFor(() => expect(screen.getByText(/Could not load the books/)).toBeDefined());
  });

  it("survives a response with no books in it", async () => {
    // A half-written response is a panel with nothing to show, not a screen
    // that throws while rendering.
    apiGet.mockResolvedValue({});
    const Books = await load();
    render(<Books api={api} />);
    await waitFor(() => screen.getByText(/Household position/));
    expect(screen.getByText(/Household position: £0.00/)).toBeDefined();
  });
});
