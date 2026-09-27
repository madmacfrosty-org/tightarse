import { pathFor } from "@tightarse/api-contract";
import { vi } from "vitest";
import { render } from "@testing-library/react";
import type { Identity, Parses } from "../src/ports";
import { transactionsResponse } from "./responses";

/**
 * One signed-in household, and the API that answers for it.
 *
 * The single page's fixtures, moved here when it became four pages. They were
 * already shared by every test in `App.test.tsx`; splitting that file would
 * otherwise have copied them three times, and a fixture that exists three times
 * is three fixtures that drift.
 *
 * Every figure, merchant and institution below is invented. Real ones are
 * household data and this repository is public.
 */

export const identity = { email: "someone@example.com", tenant: "frost" };

export const summary = {
  currency: "GBP",
  from: "2025-08-01",
  to: "2026-08-01",
  transactionCount: 4000,
  income: 100000_00,
  spend: -110000_00,
  net: -10000_00,
  byCategory: [{ category: "Groceries", total: -75830, count: 12, provisional: false }],
  byMonth: [{ month: "2026-07", income: 320000, spend: -280000, net: 40000, count: 31 }],
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
 */
export const accounts = [
  { accountId: "a1", displayName: "Main Account", institutionName: "BANK-ONE", currentBalance: -1_234_56, availableBalance: 500_00, isCard: false },
  { accountId: "a2", displayName: "Savings Account", institutionName: "BANK-ONE", currentBalance: 1_00, availableBalance: 1_00, isCard: false },
  { accountId: "c1", displayName: "Blue card", institutionName: "BANK-ONE", currentBalance: 2_000_00, availableBalance: 3_000_00, isCard: true },
  { accountId: "c2", displayName: "Travel card", institutionName: "CARD-CO", currentBalance: 500_00, isCard: true },
];

// Every field `TransactionView` requires, which is more than this fixture used
// to carry: `currency`, `accountId`, `transactionType` and `setId` were all
// missing, and `provisional` is not a field the view has at all. Nothing
// noticed until the ports began parsing (#41).
export const transactions = [
  {
    dedupKey: "k1",
    timestamp: "2026-08-01T00:00:00Z",
    amount: -1299,
    currency: "GBP",
    description: "SHOP",
    accountId: "a1",
    transactionType: "DEBIT",
    category: "Groceries",
    setId: "built-in",
  },
];

// `from` is deliberately earlier than any range the dashboard asks for, so this
// fixture represents the unclamped case. A fixture whose start is later than
// the request is a clamped one, which is a different test.
export const balances = {
  range: { from: "2000-01-01", to: "2026-03-01" },
  points: [
    { date: "2026-01-01", net: 100_00 },
    { date: "2026-02-01", net: 150_00 },
    { date: "2026-03-01", net: 120_00 },
  ],
};

/**
 * The same four accounts as books, plus a category.
 *
 * `householdPosition` deliberately equals what the account tiles come to:
 * −£1,234.56 + £1.00 − £2,000.00 − £500.00. The glance reads its headline from
 * here and its tiles from `/accounts`, and the two agreeing is the property
 * worth pinning.
 */
export const booksResponse = {
  householdPosition: -3_733_56,
  books: [
    { book: "a1", label: "Main Account", nature: "asset", rollsUp: true, position: -1_234_56 },
    { book: "a2", label: "Savings Account", nature: "asset", rollsUp: true, position: 1_00 },
    { book: "c1", label: "Blue card", nature: "liability", rollsUp: true, position: -2_000_00 },
    { book: "c2", label: "Travel card", nature: "liability", rollsUp: true, position: -500_00 },
    { book: "groceries", label: "Groceries", nature: "expense", rollsUp: false, position: 758_30 },
  ],
};

/**
 * The default responses, restored before every test by `reset`.
 *
 * Named and reinstated rather than left to `mockClear`, which clears recorded
 * calls and leaves the implementation in place — so one test overriding a
 * response silently changed every test after it.
 */
export const defaultApiGet = async (path: string): Promise<unknown> => {
  if (path.startsWith(pathFor("/books"))) return booksResponse;
  if (path.startsWith(pathFor("/summary"))) return summary;
  if (path.startsWith(pathFor("/accounts"))) return { accounts, completeFrom: "2024-01-01" };
  if (path.startsWith(pathFor("/transactions"))) return transactionsResponse(transactions);
  if (path.startsWith(pathFor("/balances"))) return balances;
  if (path.startsWith(pathFor("/categories"))) return { categories: [] };
  if (path.startsWith(pathFor("/connect/callback"))) {
    return { connectionId: "conn-1", consentExpiresAt: "2026-11-30T00:00:00.000Z" };
  }
  throw new Error(`unexpected path ${path}`);
};

export const apiGet = vi.fn(defaultApiGet);
export const apiPost = vi.fn();

/**
 * Ports supplied as objects, not a replaced module.
 *
 * `vi.mock("../src/auth")` substituted the wiring away, which is why neither the
 * CORS failure nor the blank page from a CommonJS import was reachable by any
 * test here.
 */
export const session = {
  signIn: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
  current: vi.fn(async () => identity as Identity | null),
  complete: vi.fn(async () => null as Identity | null),
};

export const api = {
  // Parses, exactly as the real adapter does (#41). A fixture that does not
  // match the contract fails here rather than proving the component works
  // against a shape the API never sends.
  get: <T,>(schema: Parses<T>, p: string) =>
    apiGet(p).then((body: unknown) => schema.parse(body)),
  post: <T,>(schema: Parses<T>, p: string, b: unknown) =>
    apiPost(p, b).then((body: unknown) => schema.parse(body)),
};

export const ports = { session, api };

/** Back to a signed-in household answering everything, at the site root. */
export function reset(): void {
  apiGet.mockReset();
  apiGet.mockImplementation(defaultApiGet);
  apiPost.mockReset();
  session.current.mockReset();
  session.current.mockImplementation(async () => identity as Identity | null);
  session.complete.mockReset();
  session.complete.mockImplementation(async () => null as Identity | null);
  session.signOut.mockReset();
  session.signIn.mockReset();
  window.history.replaceState({}, "", "/");
}

/**
 * Render the whole application at an address.
 *
 * The address is set before rendering rather than passed in, because
 * `BrowserRouter` is what ships: a memory router would let a test pass while the
 * deployed application read the path differently — and the one route where that
 * matters costs years of bank history.
 */
export async function renderAt(path: string) {
  window.history.replaceState({}, "", path);
  const { App } = await import("../src/App");
  return render(<App {...ports} />);
}

/** Every path the page asked for, in order. */
export const requested = (): string[] => apiGet.mock.calls.map((c) => String(c[0]));
