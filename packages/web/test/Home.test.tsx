import { pathFor } from "@tightarse/api-contract";
import { describe, it, expect, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { accounts, apiGet, defaultApiGet, renderAt, requested, reset } from "./harness";
import { transactionsResponse } from "./responses";

/**
 * The glance at `/`: where we stand, and how it has moved.
 *
 * These were the dashboard's tests when there was one page. What changed is the
 * address they render at and what the page is allowed to ask for — the
 * behaviour each one pins is the same, because this was a move and not a
 * rewrite.
 */

beforeEach(reset);

const home = () => renderAt("/");

describe("an account the sync has not finished describing", () => {
  // putBalances creates the account row when balances arrive before details, so
  // an account can legitimately appear mid-sync carrying a balance and nothing
  // else — no name, no institution, and no `isCard`. See #29.
  // Overrides `/accounts` and defers everything else. A catch-all return was
  // what it had, and it answered `/books` with a transactions response —
  // invisible until the ports started parsing (#41).
  const halfWritten = async (path: string) =>
    path.startsWith(pathFor("/accounts"))
      ? { accounts: [{ accountId: "half-written", currentBalance: 1000 }] }
      : defaultApiGet(path);

  it("shows a placeholder rather than a blank where the institution goes", async () => {
    // React renders undefined as nothing, which would leave the tile reading
    // "Syncing · " and looking broken rather than incomplete.
    apiGet.mockImplementation(halfWritten);
    await home();
    expect(await screen.findByText(/Syncing · —/)).toBeDefined();
  });

  it("does not call it an account, because it might be a card", async () => {
    // The defect this replaces: `isCard` absent was read as a definite "not a
    // card", so the tile said "Account" and the balance was added to cash. If
    // it turns out to be a card the position is wrong by twice the balance —
    // once for the debt not subtracted, once for cash that was never there.
    apiGet.mockImplementation(halfWritten);
    await home();
    await screen.findByText(/Syncing · —/);
    expect(screen.queryByText(/Account · —/)).toBeNull();
    expect(screen.queryByText(/Card · —/)).toBeNull();
  });

  it("shows no balance for it, because which way it signs is unknown", async () => {
    // £10.00 is either +£10.00 or −£10.00 depending on a flag we do not have.
    // A plausible number that might be inverted is worse than no number.
    apiGet.mockImplementation(halfWritten);
    await home();
    await screen.findByText(/Syncing · —/);
    expect(screen.queryByText("£10.00")).toBeNull();
    expect(screen.queryByText("−£10.00")).toBeNull();
  });

  it("leaves it out of the net position and says the figure is incomplete", async () => {
    // Excluding it understates the total, which is its own kind of wrong — so
    // the dashboard has to admit it rather than presenting a short number as
    // the household's position.
    apiGet.mockImplementation(halfWritten);
    await home();
    expect(await screen.findByText(/still\s+syncing and not included/)).toBeDefined();
  });

  it("says nothing about syncing once every account is described", async () => {
    // The warning must be tied to the state, not permanent furniture.
    await home();
    await screen.findByText("−£3,733.56");
    expect(screen.queryByText(/still\s+syncing and not included/)).toBeNull();
  });
});

describe("net position", () => {
  it("subtracts what is owed on cards instead of adding it", async () => {
    // The bug this exists for: one provider reports no available balance at
    // all, the dashboard inferred card-ness from "available exceeds current",
    // and a card debt was presented as cash. Net was wrong by twice the
    // balance — once for the debt not subtracted, once for the cash that was
    // never there. The figures here are invented; the arithmetic is the point.
    //
    // cash    -123456 + 100            = -123356
    // owed     200000 + 50000          =  250000
    // net     -123356 - 250000         = -373356
    await home();
    expect(await screen.findByText("−£3,733.56")).toBeDefined();
  });

  it("labels a card as a card and shows what is owed as a positive debt", async () => {
    await home();
    await screen.findByText("−£3,733.56");
    expect(screen.getAllByText(/Card · CARD-CO/).length).toBe(1);
    // Shown negative in the tile, because it reduces what the household has.
    // Scoped to the tiles: the same figure appears again in the books panel,
    // which is the point — both read the same number.
    const tiles = document.querySelector(".tiles")!;
    expect(tiles.textContent).toContain("−£500.00");
  });

  it("takes card-ness from the ledger, not from the balances", async () => {
    // This one sends no availableBalance at all, which is what broke the old
    // rule.
    const noAvailable = accounts.find((a) => a.accountId === "c2")!;
    expect(noAvailable.availableBalance).toBeUndefined();
    expect(noAvailable.isCard).toBe(true);
  });
});

describe("requests", () => {
  it("calls versioned paths, spelled out rather than derived", async () => {
    // Deliberately a literal "/v1/", not pathFor(). Every other test in this
    // file builds its expectation with the same helper the source uses, so if
    // the prefix were dropped both sides would move together and agree about
    // nothing. This one fails.
    //
    // #27: an installed client keeps calling whatever shape it was built
    // against, so an unversioned path served once has to be supported for ever.
    await home();
    await screen.findByText("−£3,733.56");

    const paths = requested();
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path, `${path} is not versioned`).toMatch(/^\/v1\//);
    }
  });

  it("asks for transactions by range alone, with no limit", async () => {
    // The API has never honoured `limit`, so sending it advertised a capability
    // nothing implements — and #26 is about to publish this contract, which
    // would have made the parameter look real to a client that cannot read the
    // handler. A limit without a cursor truncates rather than paginates, so the
    // parameter goes rather than gaining a server-side meaning.
    await home();
    await screen.findByText("−£3,733.56");

    const txnCalls = requested().filter((p) => p.startsWith(pathFor("/transactions")));
    expect(txnCalls.length).toBeGreaterThan(0);
    for (const path of txnCalls) {
      expect(path, `requested ${path}`).not.toMatch(/limit/);
      // Still asks for the range, so this does not pass by asking for nothing.
      expect(path).toMatch(/from=\d{4}-\d{2}-\d{2}/);
      expect(path).toMatch(/to=\d{4}-\d{2}-\d{2}/);
    }
  });

  it("asks for what it shows and nothing else", async () => {
    // Five calls on load against a Lambda concurrency limit of five is what
    // splitting the page is for. The summary belongs to `/spending` and this
    // page must not carry it back.
    await home();
    await screen.findByText("−£3,733.56");

    const paths = requested().map((p) => p.split("?")[0]).sort();
    expect(paths).toEqual([
      pathFor("/accounts"),
      pathFor("/balances"),
      pathFor("/books"),
      pathFor("/transactions"),
    ].sort());
  });

  it("asks for three months, because the glance has no control to ask with", async () => {
    // The range selector left for `/spending`. A window nobody can change has
    // to be short enough to be the answer to "how has it moved lately".
    await home();
    await screen.findByText("−£3,733.56");

    const ninetyDaysAgo = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
    for (const path of requested().filter((p) => p.includes("from="))) {
      expect(path, `requested ${path}`).toContain(`from=${ninetyDaysAgo}`);
    }
  });

  it("offers no way to change the period", async () => {
    // Choosing a window is reviewing, and reviewing has its own page. This is
    // the control that turned the original single page into something you had
    // to operate before you could read it.
    await home();
    await screen.findByText("−£3,733.56");
    for (const label of ["3 months", "12 months", "All time"]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });
});

describe("balance over time", () => {
  it("draws the series the API returned", async () => {
    await home();
    expect(await screen.findByRole("img", { name: /Net position over time/ })).toBeDefined();
  });

  it("says how far back the figure actually reaches", async () => {
    // Stated whether or not it was clamped: the start of a net-position chart
    // is a fact about the data, not a caveat, and a reader should not have to
    // infer it from the axis.
    await home();
    expect(await screen.findByText("2000-01-01")).toBeDefined();
  });

  it("explains a clamp, rather than quietly drawing less", async () => {
    apiGet.mockImplementation(async (path: string) =>
      path.startsWith(pathFor("/balances"))
        ? // Far later than the three months the glance asks for.
          {
            range: { from: "2030-01-01", to: "2030-02-01" },
            points: [{ date: "2030-01-01", net: 1 }],
          }
        : defaultApiGet(path),
    );
    await home();
    expect(await screen.findByText(/as far back as every account has data/)).toBeDefined();
  });

  it("says nothing about clamping when the full range came back", async () => {
    // Otherwise the caveat becomes permanent furniture and stops being read.
    await home();
    await screen.findByRole("img", { name: /Net position over time/ });
    expect(screen.queryByText(/as far back as every account has data/)).toBeNull();
  });
});

describe("the transaction list", () => {
  it("caps what it renders and offers the rest", async () => {
    // Not pagination — every transaction in range is already loaded. This is
    // about the DOM: a year is ~2,900 rows and all of them were being rendered.
    const many = Array.from({ length: 250 }, (_, i) => ({
      dedupKey: `d${i}`,
      timestamp: `2026-03-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
      amount: -1_00,
      currency: "GBP",
      description: `row ${i}`,
      accountId: "a1",
      transactionType: "DEBIT",
      category: "Uncategorised",
      setId: "provider",
    }));
    apiGet.mockImplementation(async (path: string) =>
      path.startsWith(pathFor("/transactions"))
        ? transactionsResponse(many)
        : defaultApiGet(path),
    );
    await home();

    expect(await screen.findByText("Showing 100 of 250.", { exact: false })).toBeDefined();
    expect(screen.queryByText("row 150")).toBeNull();
    expect(screen.getByRole("button", { name: /Show 100 more/ })).toBeDefined();
  });

  it("offers nothing more when everything is already shown", async () => {
    await home();
    await screen.findByRole("img", { name: /Net position over time/ });
    expect(screen.queryByRole("button", { name: /Show .* more/ })).toBeNull();
  });
});

describe("when the load fails", () => {
  it("says so rather than showing a page of empty figures", async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path.startsWith(pathFor("/books"))) throw new Error("Ledger unavailable");
      return defaultApiGet(path);
    });
    await home();
    expect(await screen.findByText("Ledger unavailable")).toBeDefined();
  });
});
