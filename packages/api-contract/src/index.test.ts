import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  AccountView,
  AccountsResponse,
  CategoryTotal,
  MonthTotal,
  Summary,
  TransactionView,
  TransactionsResponse,
} from "./index";

/**
 * These are about what the contract promises, not about Zod working.
 *
 * The one that matters most is the money annotation: a client generated from
 * this that loses the unit is wrong by a factor of 100 on every screen, and the
 * mistake is invisible until somebody looks at a real balance.
 */

/** Reach the schema inside `.optional()`, so a field's own description is found. */
const unwrap = (s: z.ZodTypeAny): z.ZodTypeAny =>
  s instanceof z.ZodOptional || s instanceof z.ZodNullable ? unwrap(s.unwrap()) : s;

const MONEY: Array<[string, z.ZodObject<z.ZodRawShape>, string]> = [
  ["Summary.income", Summary, "income"],
  ["Summary.spend", Summary, "spend"],
  ["Summary.net", Summary, "net"],
  ["Summary.transferTotal", Summary, "transferTotal"],
  ["CategoryTotal.total", CategoryTotal, "total"],
  ["MonthTotal.income", MonthTotal, "income"],
  ["MonthTotal.spend", MonthTotal, "spend"],
  ["MonthTotal.net", MonthTotal, "net"],
  ["TransactionView.amount", TransactionView, "amount"],
  ["AccountView.currentBalance", AccountView, "currentBalance"],
  ["AccountView.availableBalance", AccountView, "availableBalance"],
];

describe("money on the wire", () => {
  it.each(MONEY)("%s says it is in minor units", (_name, schema, field) => {
    // The unit has to travel in the contract, because it is what a generated
    // client keeps. `number` alone tells a Swift struct nothing, and this
    // project has already lost five years of ledger to an arithmetic
    // convention everyone knew and nobody wrote down.
    const described = unwrap(schema.shape[field]!).description;
    expect(described).toMatch(/minor units/);
  });

  it.each(MONEY)("%s refuses a fractional amount", (_name, schema, field) => {
    // £12.99 arriving as 12.99 rather than 1299 is the same bug seen from the
    // other end, and it parses cleanly unless integers are demanded.
    expect(unwrap(schema.shape[field]!).safeParse(12.99).success).toBe(false);
    expect(unwrap(schema.shape[field]!).safeParse(1299).success).toBe(true);
  });

  it("accepts a negative amount, because that is how money leaving is written", () => {
    // One sign convention: negative left the household. A schema that demanded
    // positives would reject every payment in the ledger.
    expect(TransactionView.shape.amount.safeParse(-1299).success).toBe(true);
  });
});

describe("what an account promises", () => {
  const stored = {
    pk: "T#frost",
    sk: "ACCOUNT#acc-1",
    gsi1pk: "T#frost#ACCOUNT#acc-1",
    tenantId: "frost",
    provider: "truelayer",
    providerAccountId: "provider-internal-id",
    accountId: "acc-1",
    displayName: "Current",
    institutionName: "First Direct",
    currency: "GBP",
    isCard: false,
    currentBalance: 123_45,
  };

  it("keeps table keys and provider ids off the wire", () => {
    // The stored row carries the partition key, the tenant and the provider's
    // own account id. None is any use to a client, and all three become a
    // promise the moment they are served.
    const parsed = AccountView.parse(stored);
    expect(parsed).not.toHaveProperty("pk");
    expect(parsed).not.toHaveProperty("sk");
    expect(parsed).not.toHaveProperty("tenantId");
    expect(parsed).not.toHaveProperty("providerAccountId");
  });

  it("keeps the fields the dashboard actually renders", () => {
    const parsed = AccountView.parse(stored);
    expect(parsed).toMatchObject({
      accountId: "acc-1",
      displayName: "Current",
      institutionName: "First Direct",
      isCard: false,
      currentBalance: 123_45,
    });
  });

  it("leaves an unfetched balance absent rather than zero", () => {
    // "We have never fetched this" and "this account holds nothing" are
    // different, and the dashboard renders them differently — a dash, not £0.00.
    const { currentBalance, ...noBalance } = stored;
    expect(currentBalance).toBeDefined();
    expect(AccountView.parse(noBalance)).not.toHaveProperty("currentBalance");
  });

  it("accepts a half-written account, because the ledger can produce one", () => {
    // putBalances creates the row when balances arrive before details, so an
    // account can be seen mid-sync with a balance and no identity. A contract
    // that demanded a displayName would fail the whole endpoint for one such
    // row, which is worse than reporting it honestly.
    const partial = { accountId: "acc-2", currentBalance: 500_00 };
    expect(AccountView.safeParse(partial).success).toBe(true);
  });

  it("leaves isCard absent rather than defaulting it to false", () => {
    // Absent means not yet known. Defaulting to false puts a card's balance in
    // the cash total and subtracts nothing, overstating the position by twice
    // the debt — the £567.90 bug reached from another direction. The stored
    // schema defaults it; the wire contract must not, because a client cannot
    // tell a default from a fact.
    const parsed = AccountView.parse({ accountId: "acc-2", currentBalance: 500_00 });
    expect(parsed).not.toHaveProperty("isCard");
    expect(parsed.isCard).toBeUndefined();
  });
});

describe("what a summary promises", () => {
  const summary = {
    currency: null,
    from: "2026-01-01",
    to: "2026-12-31",
    transactionCount: 0,
    income: 0,
    spend: 0,
    net: 0,
    byCategory: [],
    byMonth: [],
    internalTransfersNetted: true,
    transferCount: 0,
    transferTotal: 0,
    enrichedCount: 0,
  };

  it("allows a null currency, which is a real answer for an empty range", () => {
    expect(Summary.parse(summary).currency).toBeNull();
  });

  it("requires internalTransfersNetted rather than letting a client assume", () => {
    // Reported so a caller can never mistake an inflated total for a real one.
    const { internalTransfersNetted, ...without } = summary;
    expect(internalTransfersNetted).toBe(true);
    expect(Summary.safeParse(without).success).toBe(false);
  });

  it("takes dates, not timestamps, for the range", () => {
    // The API's own range parameters are YYYY-MM-DD. Echoing an instant back
    // would mean two formats for one concept.
    expect(Summary.safeParse({ ...summary, from: "2026-01-01T00:00:00Z" }).success).toBe(false);
  });
});

describe("the date formats a client has to parse", () => {
  // Formats are the part of a contract a generated client is least forgiving
  // about: a Swift decoder given "2026-3" where it expected "2026-03" fails the
  // whole response, not one field.

  it.each(["2026-03", "2025-12", "2026-01"])("accepts the month %s", (month) => {
    expect(MonthTotal.shape.month.safeParse(month).success).toBe(true);
  });

  it.each([
    ["2026-3", "an unpadded month"],
    ["26-03", "a two-digit year"],
    ["2026-03-01", "a full date"],
    ["2026", "a year alone"],
    ["", "nothing"],
    ["x2026-03", "leading junk"],
    ["2026-03x", "trailing junk"],
  ])("rejects %s (%s)", (month) => {
    expect(MonthTotal.shape.month.safeParse(month).success).toBe(false);
  });

  it.each(["2026-01-01", "2026-12-31"])("accepts the date %s", (date) => {
    expect(Summary.shape.from.safeParse(date).success).toBe(true);
  });

  it.each([
    ["2026-1-1", "unpadded parts"],
    ["2026-01-01T00:00:00Z", "an instant"],
    ["01/01/2026", "a British-looking date"],
    ["", "nothing"],
    ["2026-01-01 ", "a trailing space"],
    [" 2026-01-01", "a leading space"],
  ])("rejects %s (%s)", (date) => {
    expect(Summary.shape.from.safeParse(date).success).toBe(false);
  });
});

describe("response envelopes", () => {
  it("returns transactions alongside the range they came from", () => {
    // The dashboard labels its charts with this. A response carrying rows and
    // no range leaves the caller to assume it got what it asked for.
    const parsed = TransactionsResponse.parse({
      range: { from: "2026-01-01", to: "2026-02-01" },
      transactions: [],
    });
    expect(parsed.range).toEqual({ from: "2026-01-01", to: "2026-02-01" });
  });

  it("wraps accounts in an object, leaving room to add to the response later", () => {
    // A bare array cannot grow a sibling field without breaking every client,
    // which matters more once one of them is installed on a phone.
    expect(AccountsResponse.parse({ accounts: [] })).toEqual({ accounts: [] });
    expect(AccountsResponse.safeParse([]).success).toBe(false);
  });
});
