import { pathFor } from "@tightarse/api-contract";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const identity = { email: "someone@example.com", tenant: "frost" };

const summary = {
  currency: "GBP",
  from: "2025-08-01",
  to: "2026-08-01",
  transactionCount: 9764,
  income: 1070467_89,
  spend: -1120392_44,
  net: -49924_55,
  byCategory: [{ category: "Groceries", total: -75830, count: 12, provisional: false }],
  byMonth: [{ month: "2026-07", income: 320000, spend: -280000, net: 40000 }],
  internalTransfersNetted: true,
  transferCount: 225,
  transferTotal: 616033_18,
  enrichedCount: 5218,
};

/** The real shape, taken from the live ledger: three accounts and two cards. */
const accounts = [
  { accountId: "a1", displayName: "1st Account", institutionName: "FIRST-DIRECT", currentBalance: -400307, availableBalance: 164295, isCard: false },
  { accountId: "a2", displayName: "Savings Account", institutionName: "FIRST-DIRECT", currentBalance: 942, availableBalance: 942, isCard: false },
  { accountId: "c1", displayName: "Gold card", institutionName: "FIRST-DIRECT", currentBalance: 181447, availableBalance: 556153, isCard: true },
  { accountId: "c2", displayName: "British Airways Amex", institutionName: "AMEX", currentBalance: 56790, isCard: true },
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

const defaultApiGet = async (path: string): Promise<unknown> => {
  if (path.startsWith(pathFor("/summary"))) return summary;
  if (path.startsWith(pathFor("/accounts"))) return { accounts };
  if (path.startsWith(pathFor("/transactions"))) return { transactions };
  if (path.startsWith(pathFor("/balances"))) return balances;
  throw new Error(`unexpected path ${path}`);
};

const apiGet = vi.fn(defaultApiGet);

vi.mock("./auth", () => ({
  apiGet: (p: string) => apiGet(p),
  completeSignIn: vi.fn(async () => null),
  currentIdentity: vi.fn(async () => identity),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

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
    const { App } = await import("./App");
    render(<App />);
    expect(await screen.findByText(/Syncing · —/)).toBeDefined();
  });

  it("does not call it an account, because it might be a card", async () => {
    // The defect this replaces: `isCard` absent was read as a definite "not a
    // card", so the tile said "Account" and the balance was added to cash. If
    // it turns out to be a card the position is wrong by twice the balance —
    // once for the debt not subtracted, once for cash that was never there.
    apiGet.mockImplementation(halfWritten);
    const { App } = await import("./App");
    render(<App />);
    await screen.findByText(/Syncing · —/);
    expect(screen.queryByText(/Account · —/)).toBeNull();
    expect(screen.queryByText(/Card · —/)).toBeNull();
  });

  it("shows no balance for it, because which way it signs is unknown", async () => {
    // £10.00 is either +£10.00 or −£10.00 depending on a flag we do not have.
    // A plausible number that might be inverted is worse than no number.
    apiGet.mockImplementation(halfWritten);
    const { App } = await import("./App");
    render(<App />);
    await screen.findByText(/Syncing · —/);
    expect(screen.queryByText("£10.00")).toBeNull();
    expect(screen.queryByText("−£10.00")).toBeNull();
  });

  it("leaves it out of the net position and says the figure is incomplete", async () => {
    // Excluding it understates the total, which is its own kind of wrong — so
    // the dashboard has to admit it rather than presenting a short number as
    // the household's position.
    apiGet.mockImplementation(halfWritten);
    const { App } = await import("./App");
    render(<App />);
    expect(await screen.findByText(/still\s+syncing and not included/)).toBeDefined();
  });

  it("says nothing about syncing once every account is described", async () => {
    // The warning must be tied to the state, not permanent furniture.
    const { App } = await import("./App");
    render(<App />);
    await screen.findByText("−£6,376.02");
    expect(screen.queryByText(/still\s+syncing and not included/)).toBeNull();
  });
});

describe("net position", () => {
  it("subtracts what is owed on cards instead of adding it", async () => {
    // The bug this exists for: Amex reports no available balance, the dashboard
    // inferred card-ness from "available exceeds current", and a £567.90 debt
    // was presented as cash. Net was wrong by twice the balance — once for the
    // debt not subtracted, once for the cash that was not there.
    //
    // cash    -400307 + 942            = -399365
    // owed     181447 + 56790          =  238237
    // net     -399365 - 238237         = -637602
    const { App } = await import("./App");
    render(<App />);
    expect(await screen.findByText("−£6,376.02")).toBeDefined();
  });

  it("labels a card as a card and shows what is owed as a positive debt", async () => {
    const { App } = await import("./App");
    render(<App />);
    await screen.findByText("−£6,376.02");
    expect(screen.getAllByText(/Card · AMEX/).length).toBe(1);
    // Shown negative in the tile, because it reduces what the household has.
    expect(screen.getByText("−£567.90")).toBeDefined();
  });

  it("takes card-ness from the ledger, not from the balances", async () => {
    // Amex sends no availableBalance at all, which is what broke the old rule.
    const amex = accounts.find((a) => a.accountId === "c2")!;
    expect(amex.availableBalance).toBeUndefined();
    expect(amex.isCard).toBe(true);
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
    const { App } = await import("./App");
    render(<App />);
    await screen.findAllByText(/9,764 transactions/);

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
    const { App } = await import("./App");
    render(<App />);
    await screen.findAllByText(/9,764 transactions/);

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
    const { App } = await import("./App");
    render(<App />);
    expect(await screen.findByRole("img", { name: /Net position over time/ })).toBeDefined();
  });

  it("says how far back the figure actually reaches", async () => {
    // Stated whether or not it was clamped: the start of a net-position chart
    // is a fact about the data, not a caveat, and a reader should not have to
    // infer it from the axis.
    const { App } = await import("./App");
    render(<App />);
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
    const { App } = await import("./App");
    render(<App />);
    expect(await screen.findByText(/as far back as every account has data/)).toBeDefined();
  });

  it("says nothing about clamping when the full range came back", async () => {
    // Otherwise the caveat becomes permanent furniture and stops being read.
    const { App } = await import("./App");
    render(<App />);
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
    const { App } = await import("./App");
    render(<App />);

    expect(await screen.findByText("Showing 100 of 250.", { exact: false })).toBeDefined();
    expect(screen.queryByText("row 150")).toBeNull();
    expect(screen.getByRole("button", { name: /Show 100 more/ })).toBeDefined();
  });

  it("offers nothing more when everything is already shown", async () => {
    const { App } = await import("./App");
    render(<App />);
    await screen.findByRole("img", { name: /Net position over time/ });
    expect(screen.queryByRole("button", { name: /Show .* more/ })).toBeNull();
  });
});

describe("chrome", () => {
  it("shows the range the summary covers and the transaction count", async () => {
    const { App } = await import("./App");
    render(<App />);
    // Appears in more than one place, which is fine — assert it is present
    // rather than unique.
    expect((await screen.findAllByText(/9,764 transactions/)).length).toBeGreaterThan(0);
  });

  it("says how many internal transfers were netted out", async () => {
    // Without this the totals look wrong to anyone who knows what they moved.
    const { App } = await import("./App");
    render(<App />);
    await waitFor(() => expect(screen.getByText(/225/)).toBeDefined());
  });

  it("offers the three ranges", async () => {
    const { App } = await import("./App");
    render(<App />);
    await screen.findByText("−£6,376.02");
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
    const auth = await import("./auth");
    vi.mocked(auth.currentIdentity).mockResolvedValueOnce(null);
    const { App } = await import("./App");
    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: /sign in/i })).toBeDefined());
    expect(apiGet).not.toHaveBeenCalled();
  });
});
