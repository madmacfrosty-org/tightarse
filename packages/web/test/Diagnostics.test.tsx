import { pathFor } from "@tightarse/api-contract";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The running-balance diagnostic.
 *
 * The property worth protecting is that the screen states the verdict plainly
 * and shows the arithmetic behind it, because the whole point is that a person
 * can check a row against a statement. A panel that showed a verdict without the
 * days would be asking to be believed rather than checked.
 *
 * It also must not run on mount: it reads every account's whole history, and the
 * question is asked rarely.
 *
 * Every account id and figure here is invented.
 */

const apiGet = vi.fn();
const api = {
  get: <T,>(p: string) => apiGet(p) as Promise<T>,
  post: <T,>(p: string, b: unknown) => Promise.resolve(b as T),
};

const load = async () => (await import("../src/Diagnostics")).Diagnostics;

const account = (over: Record<string, unknown> = {}) => ({
  accountId: "acc-one",
  isCard: false,
  verdict: "closing",
  pairs: 120,
  discriminating: 118,
  closingMatches: 120,
  openingMatches: 2,
  daysChecked: 90,
  disagreeing: [],
  ...over,
});

const run = async () =>
  userEvent.click(screen.getByRole("button", { name: "Run the check" }));

beforeEach(() => {
  apiGet.mockReset();
});

describe("the running-balance diagnostic", () => {
  it("asks for nothing until it is asked to", async () => {
    const Diagnostics = await load();
    render(<Diagnostics api={api} />);

    expect(apiGet).not.toHaveBeenCalled();
  });

  it("fetches the diagnostic when run", async () => {
    apiGet.mockResolvedValue({ verdict: "closing", accounts: [account()] });
    const Diagnostics = await load();
    render(<Diagnostics api={api} />);

    await run();

    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(pathFor("/diagnostics/running-balance")),
    );
  });

  it("states the verdict and what it means, not just the word", async () => {
    apiGet.mockResolvedValue({ verdict: "closing", accounts: [account()] });
    const Diagnostics = await load();
    render(<Diagnostics api={api} />);

    await run();

    expect(await screen.findByText(/Verdict: closing/)).toBeTruthy();
    expect(screen.getByText(/position AFTER its transaction/)).toBeTruthy();
  });

  it("says plainly when the chart has been wrong, rather than burying it", async () => {
    apiGet.mockResolvedValue({
      verdict: "opening",
      accounts: [account({ verdict: "opening", closingMatches: 2, openingMatches: 120 })],
    });
    const Diagnostics = await load();
    render(<Diagnostics api={api} />);

    await run();

    expect(
      await screen.findByText(/out by one transaction, and the chart has been wrong/),
    ).toBeTruthy();
  });

  it("shows the day's arithmetic for a day that disagrees", async () => {
    apiGet.mockResolvedValue({
      verdict: "inconsistent",
      accounts: [
        account({
          verdict: "inconsistent",
          disagreeing: [
            {
              date: "2026-03-02",
              previousClosing: 100_000,
              closing: 96_502,
              movement: -450,
              difference: -3_048,
            },
          ],
        }),
      ],
    });
    const Diagnostics = await load();
    render(<Diagnostics api={api} />);

    await run();

    expect(await screen.findByText("2026-03-02")).toBeTruthy();
    // Rendered as money, so it can be read against a statement.
    expect(screen.getByText("£1000.00")).toBeTruthy();
    expect(screen.getByText("−£30.48")).toBeTruthy();
  });

  it("has no table for an account where every day agrees", async () => {
    apiGet.mockResolvedValue({ verdict: "closing", accounts: [account()] });
    const Diagnostics = await load();
    render(<Diagnostics api={api} />);

    await run();

    await screen.findByText(/Verdict: closing/);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("reports a failure instead of showing a stale answer", async () => {
    apiGet.mockRejectedValue(new Error("nope"));
    const Diagnostics = await load();
    render(<Diagnostics api={api} />);

    await run();

    expect(await screen.findByText("nope")).toBeTruthy();
  });
});
