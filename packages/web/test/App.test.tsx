import { pathFor } from "@tightarse/api-contract";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Identity } from "../src/ports";

const identity = { email: "someone@example.com", tenant: "frost" };

const summary = {
  currency: "GBP",
  from: "2025-08-01",
  to: "2026-08-01",
  transactionCount: 4000,
  income: 100000_00,
  spend: -110000_00,
  net: -10000_00,
  byCategory: [{ category: "Groceries", total: -75830, count: 12, provisional: false }],
  byMonth: [{ month: "2026-07", income: 320000, spend: -280000, net: 40000 }],
  internalTransfersNetted: true,
  transferCount: 40,
  transferTotal: 20000_00,
  balanceSheetCount: 0,
  balanceSheetTotal: 0,
  enrichedCount: 2000,
};

/**
 * Two current accounts and two cards, all invented.
 *
 * The **shape** is what the tests need, and only two properties of it are
 * load-bearing: two different institutions, so a tile's label can be checked,
 * and one card with no `availableBalance` at all. That second one is the whole
 * point — it is the state that broke the old "available exceeds current" rule
 * for inferring card-ness.
 *
 * Invented, like every figure in this repo's tests.
 */
const accounts = [
  { accountId: "a1", displayName: "Main Account", institutionName: "BANK-ONE", currentBalance: -1_234_56, availableBalance: 500_00, isCard: false },
  { accountId: "a2", displayName: "Savings Account", institutionName: "BANK-ONE", currentBalance: 1_00, availableBalance: 1_00, isCard: false },
  { accountId: "c1", displayName: "Blue card", institutionName: "BANK-ONE", currentBalance: 2_000_00, availableBalance: 3_000_00, isCard: true },
  { accountId: "c2", displayName: "Travel card", institutionName: "CARD-CO", currentBalance: 500_00, isCard: true },
];

const transactions = [
  { dedupKey: "k1", timestamp: "2026-08-01T00:00:00Z", description: "SHOP", amount: -1299, category: "Groceries", provisional: false },
];

/**
 * The default responses, restored before every test.
 *
 * Named and reinstated in `beforeEach` rather than left to `mockClear`, which
 * clears recorded calls and leaves the implementation in place — so one test
 * overriding a response silently changed every test after it.
 */
// `from` is deliberately earlier than any range the dashboard asks for, so this
// fixture represents the unclamped case. A fixture whose start is later than
// the request is a clamped one, which is a different test.
const balances = {
  range: { from: "2000-01-01", to: "2026-03-01" },
  points: [
    { date: "2026-01-01", net: 100_00 },
    { date: "2026-02-01", net: 150_00 },
    { date: "2026-03-01", net: 120_00 },
  ],
};

const booksResponse = {
  householdPosition: -1_233_56,
  books: [
    { book: "a1", label: "Main Account", nature: "asset", rollsUp: true, position: -1_234_56 },
    { book: "a2", label: "Savings Account", nature: "asset", rollsUp: true, position: 1_00 },
    { book: "groceries", label: "Groceries", nature: "expense", rollsUp: false, position: 758_30 },
  ],
};

const defaultApiGet = async (path: string): Promise<unknown> => {
  if (path.startsWith(pathFor("/books"))) return booksResponse;
  if (path.startsWith(pathFor("/summary"))) return summary;
  if (path.startsWith(pathFor("/accounts"))) return { accounts, completeFrom: "2024-01-01" };
  if (path.startsWith(pathFor("/transactions"))) return { transactions };
  if (path.startsWith(pathFor("/balances"))) return balances;
  throw new Error(`unexpected path ${path}`);
};

const apiGet = vi.fn(defaultApiGet);

/**
 * Ports supplied as objects, not a replaced module.
 *
 * `vi.mock("../src/auth")` substituted the wiring away, which is why neither this
 * week's CORS failure nor the blank page from a CommonJS import was reachable by
 * any test here.
 */
const session = {
  signIn: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
  current: vi.fn(async () => identity as Identity | null),
  complete: vi.fn(async () => null as Identity | null),
};
const apiPost = vi.fn();
const api = {
  get: <T,>(p: string) => apiGet(p) as Promise<T>,
  post: <T,>(p: string, b: unknown) => apiPost(p, b) as Promise<T>,
};
const ports = { session, api };

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockImplementation(defaultApiGet);
  window.history.replaceState({}, "", "/");
});

describe("an account the sync has not finished describing", () => {
  // putBalances creates the account row when balances arrive before details, so
  // an account can legitimately appear mid-sync carrying a balance and nothing
  // else — no name, no institution, and no `isCard`. See #29.
  const halfWritten = async (path: string) => {
    if (path.startsWith(pathFor("/accounts"))) {
      return { accounts: [{ accountId: "half-written", currentBalance: 1000 }] };
    }
    if (path.startsWith(pathFor("/summary"))) return summary;
    if (path.startsWith(pathFor("/balances"))) return balances;
    return { transactions: [] };
  };

  it("shows a placeholder rather than a blank where the institution goes", async () => {
    // React renders undefined as nothing, which would leave the tile reading
    // "Syncing · " and looking broken rather than incomplete.
    apiGet.mockImplementation(halfWritten);
    const { App } = await import("../src/App");
    render(<App {...ports} />);
    expect(await screen.findByText(/Syncing · —/)).toBeDefined();
  });

  it("does not call it an account, because it might be a card", async () => {
    // The defect this replaces: `isCard` absent was read as a definite "not a
    // card", so the tile said "Account" and the balance was added to cash. If
    // it turns out to be a card the position is wrong by twice the balance —
    // once for the debt not subtracted, once for cash that was never there.
    apiGet.mockImplementation(halfWritten);
    const { App } = await import("../src/App");
    render(<App {...ports} />);
    await screen.findByText(/Syncing · —/);
    expect(screen.queryByText(/Account · —/)).toBeNull();
    expect(screen.queryByText(/Card · —/)).toBeNull();
  });

  it("shows no balance for it, because which way it signs is unknown", async () => {
    // £10.00 is either +£10.00 or −£10.00 depending on a flag we do not have.
    // A plausible number that might be inverted is worse than no number.
    apiGet.mockImplementation(halfWritten);
    const { App } = await import("../src/App");
    render(<App {...ports} />);
    await screen.findByText(/Syncing · —/);
    expect(screen.queryByText("£10.00")).toBeNull();
    expect(screen.queryByText("−£10.00")).toBeNull();
  });

  it("leaves it out of the net position and says the figure is incomplete", async () => {
    // Excluding it understates the total, which is its own kind of wrong — so
    // the dashboard has to admit it rather than presenting a short number as
    // the household's position.
    apiGet.mockImplementation(halfWritten);
    const { App } = await import("../src/App");
    render(<App {...ports} />);
    expect(await screen.findByText(/still\s+syncing and not included/)).toBeDefined();
  });

  it("says nothing about syncing once every account is described", async () => {
    // The warning must be tied to the state, not permanent furniture.
    const { App } = await import("../src/App");
    render(<App {...ports} />);
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
    const { App } = await import("../src/App");
    render(<App {...ports} />);
    expect(await screen.findByText("−£3,733.56")).toBeDefined();
  });

  it("labels a card as a card and shows what is owed as a positive debt", async () => {
    const { App } = await import("../src/App");
    render(<App {...ports} />);
    await screen.findByText("−£3,733.56");
    expect(screen.getAllByText(/Card · CARD-CO/).length).toBe(1);
    // Shown negative in the tile, because it reduces what the household has.
    expect(screen.getByText("−£500.00")).toBeDefined();
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
    const { App } = await import("../src/App");
    render(<App {...ports} />);
    await screen.findAllByText(/4,000 transactions/);

    const paths = apiGet.mock.calls.map((c) => String(c[0]));
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
    const { App } = await import("../src/App");
    render(<App {...ports} />);
    await screen.findAllByText(/4,000 transactions/);

    const txnCalls = apiGet.mock.calls.map((c) => String(c[0])).filter((p) => p.startsWith(pathFor("/transactions")));
    expect(txnCalls.length).toBeGreaterThan(0);
    for (const path of txnCalls) {
      expect(path, `requested ${path}`).not.toMatch(/limit/);
      // Still asks for the range, so this does not pass by asking for nothing.
      expect(path).toMatch(/from=\d{4}-\d{2}-\d{2}/);
      expect(path).toMatch(/to=\d{4}-\d{2}-\d{2}/);
    }
  });
});

describe("balance over time", () => {
  it("draws the series the API returned", async () => {
    const { App } = await import("../src/App");
    render(<App {...ports} />);
    expect(await screen.findByRole("img", { name: /Net position over time/ })).toBeDefined();
  });

  it("says how far back the figure actually reaches", async () => {
    // Stated whether or not it was clamped: the start of a net-position chart
    // is a fact about the data, not a caveat, and a reader should not have to
    // infer it from the axis.
    const { App } = await import("../src/App");
    render(<App {...ports} />);
    expect(await screen.findByText("2000-01-01")).toBeDefined();
  });

  it("explains a clamp, rather than quietly drawing less", async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path.startsWith(pathFor("/summary"))) return summary;
      if (path.startsWith(pathFor("/accounts"))) return { accounts };
      if (path.startsWith(pathFor("/transactions"))) return { transactions };
      // Far later than the year the dashboard asks for by default.
      return { range: { from: "2030-01-01", to: "2030-02-01" }, points: [{ date: "2030-01-01", net: 1 }] };
    });
    const { App } = await import("../src/App");
    render(<App {...ports} />);
    expect(await screen.findByText(/as far back as every account has data/)).toBeDefined();
  });

  it("says nothing about clamping when the full range came back", async () => {
    // Otherwise the caveat becomes permanent furniture and stops being read.
    const { App } = await import("../src/App");
    render(<App {...ports} />);
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
      provisional: false,
    }));
    apiGet.mockImplementation(async (path: string) => {
      if (path.startsWith(pathFor("/summary"))) return summary;
      if (path.startsWith(pathFor("/accounts"))) return { accounts };
      if (path.startsWith(pathFor("/balances"))) return balances;
      return { transactions: many };
    });
    const { App } = await import("../src/App");
    render(<App {...ports} />);

    expect(await screen.findByText("Showing 100 of 250.", { exact: false })).toBeDefined();
    expect(screen.queryByText("row 150")).toBeNull();
    expect(screen.getByRole("button", { name: /Show 100 more/ })).toBeDefined();
  });

  it("offers nothing more when everything is already shown", async () => {
    const { App } = await import("../src/App");
    render(<App {...ports} />);
    await screen.findByRole("img", { name: /Net position over time/ });
    expect(screen.queryByRole("button", { name: /Show .* more/ })).toBeNull();
  });
});

describe("chrome", () => {
  it("shows the range the summary covers and the transaction count", async () => {
    const { App } = await import("../src/App");
    render(<App {...ports} />);
    // Appears in more than one place, which is fine — assert it is present
    // rather than unique.
    expect((await screen.findAllByText(/4,000 transactions/)).length).toBeGreaterThan(0);
  });

  it("says how many internal transfers were netted out", async () => {
    // Without this the totals look wrong to anyone who knows what they moved.
    const { App } = await import("../src/App");
    render(<App {...ports} />);
    // "40 legs" rather than /40/: a bare number matches the transaction count
    // and the amounts too, so the old matcher passed on whatever it found.
    await waitFor(() => expect(screen.getByText(/40 legs/)).toBeDefined());
  });

  it("asks for the known window on All time, not for everything", async () => {
    // The bug this replaces: "All time" sent a fifty-year range to every
    // endpoint. The chart clamps and was fine; the transaction list does not,
    // and the full history is over Lambda's 6MB response limit — so it failed
    // with a 500 after several seconds of loading.
    const { App } = await import("../src/App");
    render(<App {...ports} />);
    await screen.findByText("−£3,733.56");

    const allTime = screen.getByRole("button", { name: "All time" });
    expect((allTime as HTMLButtonElement).disabled).toBe(false);
    apiGet.mockClear();
    apiGet.mockImplementation(defaultApiGet);
    fireEvent.click(allTime);

    await waitFor(() => {
      const txn = apiGet.mock.calls.map(String).find((p) => p.includes("/transactions"));
      expect(txn).toBeDefined();
      // completeFrom from the accounts response, not fifty years ago.
      expect(txn).toContain("from=2024-01-01");
    });
  });

  it("does not offer All time before it knows what that means", async () => {
    // Offering it early would silently show twelve months under a label
    // promising everything.
    apiGet.mockImplementation(async (path: string) => {
      if (path.startsWith(pathFor("/summary"))) return summary;
      if (path.startsWith(pathFor("/accounts"))) return { accounts };
      if (path.startsWith(pathFor("/transactions"))) return { transactions };
      return balances;
    });
    const { App } = await import("../src/App");
    render(<App {...ports} />);
    await screen.findByText("−£3,733.56");
    expect((screen.getByRole("button", { name: "All time" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers the three ranges", async () => {
    const { App } = await import("../src/App");
    render(<App {...ports} />);
    await screen.findByText("−£3,733.56");
    // "All time" rather than a fixed span: how far back a household total is
    // trustworthy is set by the shallowest account and widens a day at a time,
    // so a constant would be wrong today and wrong differently later. #33.
    for (const label of ["3 months", "12 months", "All time"]) {
      expect(screen.getByRole("button", { name: label })).toBeDefined();
    }
  });
});

describe("when nobody is signed in", () => {
  it("offers sign-in rather than an empty dashboard", async () => {
    // Nobody signed in: the port says so directly, rather than a module being
    // reached into and re-mocked mid-test.
    session.current.mockResolvedValueOnce(null);
    const { App } = await import("../src/App");
    render(<App {...ports} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /sign in/i })).toBeDefined());
    expect(apiGet).not.toHaveBeenCalled();
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
    const { App } = await import("../src/App");
    render(<App {...ports} />);
    await screen.findByText(/moved\s+rather than were spent/);
    const text = document.body.textContent ?? "";
    expect(text).toContain("A further 4");
    expect(text).toContain("£1,250.00");
  });

  it("says nothing at all when nothing was left out", async () => {
    const { App } = await import("../src/App");
    render(<App {...ports} />);
    await screen.findByText(/Money in and out/);
    expect(document.body.textContent).not.toContain("rather than were spent");
  });

  it("reads as one transaction rather than 1 transactions", async () => {
    apiGet.mockImplementation(withExcluded(1, 10_00));
    const { App } = await import("../src/App");
    render(<App {...ports} />);
    await screen.findByText(/moved\s+rather than were spent/);
    expect(document.body.textContent).toContain("A further 1 transaction");
  });
});
