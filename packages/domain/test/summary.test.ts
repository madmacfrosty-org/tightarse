import { describe, it, expect } from "vitest";
import {
  summarise,
  mergeCategories,
  toAccountState,
} from "../src/reporting/summary.js";
import type { Categorisation } from "../src/categorisation/categorisation.js";
import { recorded, assigned } from "./recorded.js";

const row = recorded;

const range = { from: "2026-01-01", to: "2026-12-31" };

describe("summarise", () => {
  it("separates income from spend using the sign, not the type field", () => {
    const s = summarise(
      [row({ amount: -1000 }), row({ dedupKey: "n:2", amount: 2500 })],
      [],
      range,
    );
    expect(s.spend).toBe(-1000);
    expect(s.income).toBe(2500);
    expect(s.net).toBe(1500);
  });

  it("refuses to sum across currencies", () => {
    expect(() =>
      summarise([row(), row({ dedupKey: "n:2", currency: "EUR" })], [], range),
    ).toThrow(/Cannot aggregate across currencies/);
  });

  it("prefers our category over the provider's and marks the difference", () => {
    const enr: Categorisation[] = [assigned("n:1", "Groceries")];
    const s = summarise([row()], enr, range);
    expect(s.byCategory[0]!.category).toBe("Groceries");
    expect(s.byCategory[0]!.provisional).toBe(false);
    expect(s.enrichedCount).toBe(1);

    const bare = summarise([row()], [], range);
    expect(bare.byCategory[0]!.category).toBe("PURCHASE");
    expect(bare.byCategory[0]!.provisional).toBe(true);
    expect(bare.enrichedCount).toBe(0);
  });

  it("falls back to UNCATEGORISED rather than dropping a row", () => {
    const s = summarise([row({ providerCategory: undefined })], [], range);
    expect(s.byCategory[0]!.category).toBe("UNCATEGORISED");
    expect(s.transactionCount).toBe(1);
  });

  it("buckets by month and orders chronologically", () => {
    const s = summarise(
      [
        row({ timestamp: "2026-05-01T00:00:00Z" }),
        row({ dedupKey: "n:2", timestamp: "2026-03-01T00:00:00Z" }),
        row({ dedupKey: "n:3", timestamp: "2026-03-20T00:00:00Z" }),
      ],
      [],
      range,
    );
    expect(s.byMonth.map((m) => m.month)).toEqual(["2026-03", "2026-05"]);
    expect(s.byMonth[0]!.count).toBe(2);
  });

  it("orders categories by largest spend first", () => {
    const s = summarise(
      [
        row({ amount: -100, providerCategory: "SMALL" }),
        row({ dedupKey: "n:2", amount: -9000, providerCategory: "BIG" }),
      ],
      [],
      range,
    );
    expect(s.byCategory[0]!.category).toBe("BIG");
  });

  it("nets internal transfers by default, and says so", () => {
    // An aggregated ledger shows a transfer between own accounts as both spend
    // and income. The flag is reported either way so a caller can never mistake
    // an inflated total for a real one.
    expect(summarise([row()], [], range).internalTransfersNetted).toBe(true);
    expect(
      summarise([row()], [], range, { transfers: false })
        .internalTransfersNetted,
    ).toBe(false);
  });

  it("handles an empty range without inventing a currency", () => {
    const s = summarise([], [], range);
    expect(s.currency).toBeNull();
    expect(s.net).toBe(0);
    expect(s.byMonth).toEqual([]);
  });
});

describe("mergeCategories", () => {
  it("serves the contract's fields and nothing else the row was carrying", () => {
    // The spread this replaced put the table keys, the tenant id, the provider's
    // transaction ids and the raw object's S3 key into every response. Nothing
    // read them and the contract never named them, but they were served, and a
    // served field is a promise. `wire.ts` copies the array rather than
    // projecting it, so this function is where the boundary actually is.
    const [merged] = mergeCategories(
      [recorded({ providerCategory: undefined })],
      [],
    );

    expect(Object.keys(merged!).sort()).toEqual([
      "accountId",
      "amount",
      "category",
      "currency",
      "dedupKey",
      "description",
      "setId",
      "timestamp",
      "transactionType",
    ]);
  });

  it("includes the provider's category only when the row has one", () => {
    const [with_] = mergeCategories(
      [recorded({ providerCategory: "PURCHASE" })],
      [],
    );
    expect(with_).toHaveProperty("providerCategory", "PURCHASE");

    // Absent, not present-and-undefined: the contract marks it optional, and
    // `undefined` would serialise the key with a null in some clients.
    const [without] = mergeCategories(
      [recorded({ providerCategory: undefined })],
      [],
    );
    expect(Object.keys(without!)).not.toContain("providerCategory");
  });

  it("returns newest first with categories attached", () => {
    const merged = mergeCategories(
      [
        row({ timestamp: "2026-01-01T00:00:00Z" }),
        row({ dedupKey: "n:2", timestamp: "2026-06-01T00:00:00Z" }),
      ],
      [assigned("n:2", "Transport")],
    );
    expect(merged[0]!.timestamp).toBe("2026-06-01T00:00:00Z");
    expect(merged[0]!.category).toBe("Transport");
    // Nothing assigned it, so it falls back to the provider's own value and
    // says so by naming that set rather than by a flag.
    expect(merged[1]!.setId).toBe("provider");
  });
});

describe("projecting a stored account for a client", () => {
  const full = {
    pk: "T#frost",
    sk: "ACCOUNT#acc-1",
    kind: "ACCOUNT",
    tenantId: "frost",
    provider: "truelayer",
    providerAccountId: "provider-internal-id",
    accountId: "acc-1",
    displayName: "Current",
    institutionName: "First Direct",
    currency: "GBP",
    isCard: true,
    accountType: "TRANSACTION",
    currentBalance: 123_45,
    availableBalance: 100_00,
    lastSyncedAt: "2026-08-15T06:00:00Z",
  };

  it("keeps every field the contract publishes and nothing else", () => {
    expect(toAccountState(full)).toEqual({
      accountId: "acc-1",
      displayName: "Current",
      institutionName: "First Direct",
      currency: "GBP",
      isCard: true,
      accountType: "TRANSACTION",
      currentBalance: 123_45,
      availableBalance: 100_00,
      lastSyncedAt: "2026-08-15T06:00:00Z",
    });
  });

  it("omits what the row does not have, rather than inventing it", () => {
    // putBalances creates a row with balances and no identity, so every one of
    // these is genuinely absent in production. A default here would be a client
    // reading a made-up institution name, or worse a made-up isCard.
    expect(toAccountState({ accountId: "acc-2" })).toEqual({
      accountId: "acc-2",
    });
  });

  it("ignores a field of the wrong type instead of passing it through", () => {
    // The row is Record<string, unknown> straight from DynamoDB. A number where
    // a name belongs should not reach a generated client that expects a string.
    expect(
      toAccountState({
        accountId: "acc-3",
        displayName: 42,
        currentBalance: "lots",
      }),
    ).toEqual({
      accountId: "acc-3",
    });
  });

  it("survives a row with no accountId rather than throwing", () => {
    // Would mean a corrupt row. Failing the whole endpoint hides every other
    // account, and a missing account understates the household's position.
    expect(toAccountState({}).accountId).toBe("");
  });
});
