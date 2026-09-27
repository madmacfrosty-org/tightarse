import { pathFor } from "@tightarse/api-contract";
import { describe, it, expect, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { accounts, apiGet, defaultApiGet, renderAt, requested, reset, summary } from "./harness";

/**
 * Review, at `/spending`: where the money went over a period you choose.
 *
 * The range lives here now. It is the control that made the glance something
 * you had to operate before you could read it, and it is the whole point of
 * this page — so the tests that were about it moved with it.
 */

beforeEach(reset);

const spending = (query = "") => renderAt(`/spending${query}`);

/** The summary requests, which are the only ones the range changes. */
const summaries = () => requested().filter((p) => p.startsWith(pathFor("/summary")));

describe("the period", () => {
  it("shows what the figures cover and how many transactions that is", async () => {
    await spending();
    // Appears in more than one place, which is fine — assert it is present
    // rather than unique.
    expect((await screen.findAllByText(/4,000 transactions/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/2025-08-01 to 2026-08-01/)).toBeDefined();
  });

  it("offers the three ranges", async () => {
    await spending();
    await screen.findByText("Where it goes");
    // "All time" rather than a fixed span: how far back a household total is
    // trustworthy is set by the shallowest account and widens a day at a time,
    // so a constant would be wrong today and wrong differently later. #33.
    for (const label of ["3 months", "12 months", "All time"]) {
      expect(screen.getByRole("button", { name: label })).toBeDefined();
    }
  });

  it("asks for the known window on All time, not for everything", async () => {
    // The bug this replaces: "All time" sent a fifty-year range to every
    // endpoint. The chart clamps and was fine; the transaction list does not,
    // and the full history is over Lambda's 6MB response limit — so it failed
    // with a 500 after several seconds of loading.
    await spending();
    await screen.findByText("Where it goes");

    const allTime = screen.getByRole("button", { name: "All time" });
    expect((allTime as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(allTime);

    await waitFor(() => {
      // completeFrom from the accounts response, not fifty years ago.
      expect(summaries().some((p) => p.includes("from=2024-01-01"))).toBe(true);
    });
  });

  it("does not offer All time before it knows what that means", async () => {
    // Offering it early would silently show twelve months under a label
    // promising everything.
    apiGet.mockImplementation(async (path: string) =>
      path.startsWith(pathFor("/accounts")) ? { accounts } : defaultApiGet(path),
    );
    await spending();
    await screen.findByText("Where it goes");
    expect((screen.getByRole("button", { name: "All time" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("puts the chosen range in the address, so a review can be returned to", async () => {
    // A page whose address is the same whatever it shows has to be
    // reconstructed every time, which is most of the cost of doing a review.
    await spending();
    await screen.findByText("Where it goes");
    await userEvent.click(screen.getByRole("button", { name: "3 months" }));
    await waitFor(() => expect(window.location.search).toBe("?range=3m"));
  });

  it("comes back the same when that address is opened again", async () => {
    await spending("?range=3m");
    await screen.findByText("Where it goes");
    expect((screen.getByRole("button", { name: "3 months" })).getAttribute("aria-pressed")).toBe("true");
    const ninetyDaysAgo = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
    expect(summaries()[0]).toContain(`from=${ninetyDaysAgo}`);
  });

  it("waits for the window rather than reporting a year under an All time heading", async () => {
    // A linked `?range=all` arrives before `completeFrom` does. The button
    // guard cannot help here, because nobody pressed it.
    await spending("?range=all");
    await waitFor(() => expect(summaries().length).toBe(1));
    expect(summaries()[0]).toContain("from=2024-01-01");
  });

  it("asks for the summary once per load, not twice", async () => {
    // `completeFrom` arriving used to re-run the whole load: every panel
    // fetched twice on every page load. The effect depends on the window it
    // asks for, not on the state that computes it.
    await spending();
    await screen.findByText("Where it goes");
    await waitFor(() => expect(summaries().length).toBe(1));
  });
});

describe("money in and out", () => {
  it("says how many internal transfers were netted out", async () => {
    // Without this the totals look wrong to anyone who knows what they moved.
    await spending();
    // "40 legs" rather than /40/: a bare number matches the transaction count
    // and the amounts too, so the old matcher passed on whatever it found.
    await waitFor(() => expect(screen.getByText(/40 legs/)).toBeDefined());
  });
});

/**
 * #109: saying what was left out of spending.
 *
 * Excluding a category from the totals is the one change in #108 step 3 that can
 * make a figure quietly smaller, and a total that shrank silently reads exactly
 * like one that was right. So the screen has to say it happened.
 *
 * Every figure here is invented.
 */
describe("money that moved rather than was spent", () => {
  const withExcluded = (count: number, total: number) => async (path: string) =>
    path.startsWith(pathFor("/summary"))
      ? { ...summary, balanceSheetCount: count, balanceSheetTotal: total }
      : defaultApiGet(path);

  it("says how much was left out, and why", async () => {
    apiGet.mockImplementation(withExcluded(4, 1_250_00));
    await spending();
    await screen.findByText(/moved\s+rather than were spent/);
    const text = document.body.textContent ?? "";
    expect(text).toContain("A further 4");
    expect(text).toContain("£1,250.00");
  });

  it("says nothing at all when nothing was left out", async () => {
    await spending();
    await screen.findByText(/Money in and out/);
    expect(document.body.textContent).not.toContain("rather than were spent");
  });

  it("reads as one transaction rather than 1 transactions", async () => {
    apiGet.mockImplementation(withExcluded(1, 10_00));
    await spending();
    await screen.findByText(/moved\s+rather than were spent/);
    expect(document.body.textContent).toContain("A further 1 transaction");
  });
});

describe("when the load fails", () => {
  it("says so rather than showing an empty breakdown", async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path.startsWith(pathFor("/summary"))) throw new Error("Summary unavailable");
      return defaultApiGet(path);
    });
    await spending();
    expect(await screen.findByText("Summary unavailable")).toBeDefined();
  });
});
