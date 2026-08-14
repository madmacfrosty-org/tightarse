import { describe, it, expect } from "vitest";
import { summarise, mergeEnrichments, type LedgerRow, type EnrichmentRow } from "./aggregate.js";

/**
 * Overrides for a test-data builder.
 *
 * `Partial<T>` cannot express "remove this field" under
 * exactOptionalPropertyTypes, and a blanket `| undefined` would let a REQUIRED
 * field be blanked, which is a different bug. Undefined is allowed only where
 * the property is already optional.
 */
type Overrides<T> = { [K in keyof T]?: undefined extends T[K] ? T[K] | undefined : T[K] };

const row = (over: Overrides<LedgerRow> = {}): LedgerRow =>
  // An optional field set to undefined is absent for our purposes; the spread
  // type cannot say that under exactOptionalPropertyTypes.
  ({
    dedupKey: "n:1",
    timestamp: "2026-03-15T00:00:00Z",
    amount: -1299,
    currency: "GBP",
    description: "SHOP",
    accountId: "acc1",
    providerCategory: "PURCHASE",
    transactionType: "DEBIT",
    ...over,
  }) as LedgerRow;

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
    const enr: EnrichmentRow[] = [{ dedupKey: "n:1", category: "Groceries" }];
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
    expect(summarise([row()], [], range, { transfers: false }).internalTransfersNetted).toBe(false);
  });

  it("handles an empty range without inventing a currency", () => {
    const s = summarise([], [], range);
    expect(s.currency).toBeNull();
    expect(s.net).toBe(0);
    expect(s.byMonth).toEqual([]);
  });
});

describe("mergeEnrichments", () => {
  it("returns newest first with categories attached", () => {
    const merged = mergeEnrichments(
      [row({ timestamp: "2026-01-01T00:00:00Z" }), row({ dedupKey: "n:2", timestamp: "2026-06-01T00:00:00Z" })],
      [{ dedupKey: "n:2", category: "Transport" }],
    );
    expect(merged[0]!.timestamp).toBe("2026-06-01T00:00:00Z");
    expect(merged[0]!.category).toBe("Transport");
    expect(merged[1]!.provisional).toBe(true);
  });
});
