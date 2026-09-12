import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Books } from "../src/Books";

/**
 * Every book on screen.
 *
 * The property worth protecting is the split: what the household is worth,
 * separately from what has passed through it. A panel that listed them together
 * would put a year's groceries next to a current account and invite adding them
 * up.
 *
 * Every figure and label is invented.
 */

const data = {
  householdPosition: -178_000_00,
  books: [
    { book: "cur", label: "Main Account", nature: "asset" as const, rollsUp: true, position: 2_000_00 },
    { book: "card", label: "Blue card", nature: "liability" as const, rollsUp: true, position: -500_00 },
    { book: "mortgage", label: "Mortgage", nature: "liability" as const, rollsUp: true, position: -179_500_00 },
    { book: "groceries", label: "Groceries", nature: "expense" as const, rollsUp: false, position: 12_450_00 },
    { book: "transfer", label: "Transfer", nature: "asset" as const, rollsUp: false, position: 296_897_49 },
  ],
};

describe("every book", () => {
  it("states the household's position", () => {
    render(<Books data={data} />);
    expect(screen.getByText(/Household position: −£178,000.00/)).toBeDefined();
  });

  it("puts a loan among what the household is worth, not among what it spent", () => {
    // The reason `liability` exists. A mortgage is not an expense: it is a
    // position, and repaying it moves nothing.
    render(<Books data={data} />);
    const worth = screen.getByLabelText("What the household is worth");
    expect(worth.textContent).toContain("Mortgage");
    expect(worth.textContent).toContain("−£179,500.00");
  });

  it("keeps spending out of what the household is worth", () => {
    render(<Books data={data} />);
    expect(
      screen.getByLabelText("What the household is worth").textContent,
    ).not.toContain("Groceries");
    expect(
      screen.getByLabelText("What has passed through").textContent,
    ).toContain("Groceries");
  });

  it("shows an asset that does not count among what passed through", () => {
    // Transfer: not spending, so its nature is asset — but where the money went
    // is the one thing a transfer does not say, so it is not claimed as held.
    render(<Books data={data} />);
    expect(
      screen.getByLabelText("What has passed through").textContent,
    ).toContain("Transfer");
  });

  it("shows a card and a loan the same way, because they are the same thing", () => {
    render(<Books data={data} />);
    expect(screen.getByText("−£500.00")).toBeDefined();
    expect(screen.getAllByText("liability").length).toBe(2);
  });

  it("says it is loading rather than rendering an empty table", () => {
    render(<Books data={null} />);
    expect(screen.getByText("Loading…")).toBeDefined();
  });

  it("survives a response with no books in it", () => {
    render(<Books data={{ householdPosition: 0 } as never} />);
    expect(screen.getByText(/Household position: £0.00/)).toBeDefined();
  });
});
