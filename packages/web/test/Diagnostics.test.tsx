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
  displacements: [],
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

/**
 * Naming the suspect.
 *
 * A day row says money went missing; a displacement says which transaction and
 * where the bank put it. The distinction the panel has to keep visible is
 * between a pair that cancels (misfiled, and we hold the row) and a lone day
 * (absent, and we do not) — they call for completely different work.
 *
 * Every description, merchant and figure here is invented.
 */
describe("displaced transactions on screen", () => {
  const suspect = {
    dedupKey: "d1",
    timestamp: "2026-04-14T00:00:00Z",
    description: "SOMEMART 118",
    amount: -50_00,
    status: "settled",
    merchantName: "Somemart",
  };
  const displaced = {
    ledgerDate: "2026-04-14",
    bankDate: "2026-04-07",
    displacedBy: 7,
    amount: -50_00,
    candidates: [suspect],
  };

  it("names the transaction and both dates", async () => {
    const Diagnostics = await load();
    apiGet.mockResolvedValue({
      verdict: "inconsistent",
      accounts: [account({ verdict: "inconsistent", displacements: [displaced] })],
    });
    render(<Diagnostics api={api} />);
    await run();
    await waitFor(() => screen.getByText("SOMEMART 118"));
    expect(screen.getByText("Somemart")).toBeTruthy();
    expect(screen.getByText("−£50.00")).toBeTruthy();
    const prose = document.body.textContent ?? "";
    expect(prose).toContain("2026-04-07");
    expect(prose).toContain("2026-04-14");
    expect(prose).toContain("7 days later than the bank");
  });

  it("says the other direction when we date it first", async () => {
    const Diagnostics = await load();
    apiGet.mockResolvedValue({
      verdict: "inconsistent",
      accounts: [
        account({
          displacements: [
            { ...displaced, displacedBy: -3, bankDate: "2026-04-17" },
          ],
        }),
      ],
    });
    render(<Diagnostics api={api} />);
    await run();
    await waitFor(() => screen.getByText("SOMEMART 118"));
    expect(document.body.textContent).toContain("3 days earlier than the bank");
  });

  it("says plainly when the days cancel but we hold no such transaction", async () => {
    // The case that means something is absent rather than misfiled. Showing an
    // empty table here would read as "nothing to see".
    const Diagnostics = await load();
    apiGet.mockResolvedValue({
      verdict: "inconsistent",
      accounts: [
        account({ displacements: [{ ...displaced, candidates: [] }] }),
      ],
    });
    render(<Diagnostics api={api} />);
    await run();
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "absent rather than something misfiled",
      ),
    );
    expect(screen.queryByText("SOMEMART 118")).toBeNull();
  });

  it("admits it cannot choose when two transactions match the amount", async () => {
    const Diagnostics = await load();
    apiGet.mockResolvedValue({
      verdict: "inconsistent",
      accounts: [
        account({
          displacements: [
            {
              ...displaced,
              candidates: [
                suspect,
                { ...suspect, dedupKey: "d2", description: "SOMEMART 902" },
              ],
            },
          ],
        }),
      ],
    });
    render(<Diagnostics api={api} />);
    await run();
    await waitFor(() => screen.getByText("SOMEMART 902"));
    expect(document.body.textContent).toContain("cannot say which");
  });

  it("does not list a day twice when a displacement already explains it", async () => {
    // The day rows and the displacements describe the same fault. Showing the
    // paired days in both places would read as four problems instead of two.
    const Diagnostics = await load();
    const day = (date: string, difference: number) => ({
      date,
      closing: 0,
      previousClosing: 0,
      movement: -difference,
      difference,
    });
    apiGet.mockResolvedValue({
      verdict: "inconsistent",
      accounts: [
        account({
          disagreeing: [
            day("2026-04-07", 50_00),
            day("2026-04-14", -50_00),
            day("2026-05-01", 12_34),
          ],
          displacements: [displaced],
        }),
      ],
    });
    render(<Diagnostics api={api} />);
    await run();
    await waitFor(() => screen.getByText("SOMEMART 118"));
    expect(screen.getAllByRole("row").filter((r) => r.textContent?.includes("2026-05-01"))).toHaveLength(1);
    expect(document.body.textContent).toContain("1 day where the balance moved");
    expect(document.body.textContent).not.toContain("3 days where the balance moved");
  });

  it("points out when nothing informative supports the opening reading", async () => {
    // The reasoning that settled the question by hand: a pair whose amounts are
    // equal matches both readings, so it cannot be evidence for either.
    const Diagnostics = await load();
    apiGet.mockResolvedValue({
      verdict: "inconsistent",
      accounts: [account({ pairs: 236, discriminating: 229, closingMatches: 219, openingMatches: 7 })],
    });
    render(<Diagnostics api={api} />);
    await run();
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "No pair carrying information supports it",
      ),
    );
  });
});
