import { describe, it, expect } from "vitest";
import { mapTransaction, mapAccount, mapBalance, handlerFor, type RawTransaction } from "./map.js";

const raw = (over: Partial<RawTransaction> = {}): RawTransaction => ({
  timestamp: "2026-08-08T00:00:00Z",
  description: "SHOP 123",
  transaction_type: "DEBIT",
  transaction_category: "PURCHASE",
  transaction_classification: [],
  amount: -12.99,
  currency: "GBP",
  transaction_id: "unstable",
  provider_transaction_id: "prov",
  normalised_provider_transaction_id: "norm",
  running_balance: { currency: "GBP", amount: 1234.56 },
  ...over,
});

const ctx = { tenantId: "frost", accountId: "acc1", status: "settled" as const };

describe("mapTransaction", () => {
  it("converts major-unit floats to minor units without losing a penny", () => {
    expect(mapTransaction(raw(), ctx).amount).toBe(-1299);
    expect(mapTransaction(raw({ amount: 0.29 }), ctx).amount).toBe(29);
  });

  it("unwraps running_balance, which is an object rather than a scalar", () => {
    expect(mapTransaction(raw(), ctx).runningBalance).toBe(123456);
    expect(mapTransaction(raw({ running_balance: undefined }), ctx).runningBalance).toBeUndefined();
  });

  it("drops an empty classification rather than storing it", () => {
    // First Direct supplies none at all. An empty array would read as "we
    // looked and found nothing" instead of "the provider does not offer this".
    expect(mapTransaction(raw(), ctx).providerClassification).toBeUndefined();
    expect(
      mapTransaction(raw({ transaction_classification: ["Food", "Groceries"] }), ctx)
        .providerClassification,
    ).toEqual(["Food", "Groceries"]);
  });

  it("carries all three id fields, so the dedup chain can degrade", () => {
    const t = mapTransaction(raw(), ctx);
    expect(t.transactionId).toBe("unstable");
    expect(t.providerTransactionId).toBe("prov");
    expect(t.normalisedProviderTransactionId).toBe("norm");
  });

  it("takes status from the caller, not the payload", () => {
    // Settled and pending come from different endpoints and are otherwise
    // indistinguishable — nothing in the row says which it is.
    expect(mapTransaction(raw(), { ...ctx, status: "pending" }).status).toBe("pending");
  });

  it("treats anything that is not CREDIT as a debit", () => {
    expect(mapTransaction(raw({ transaction_type: "CREDIT" }), ctx).transactionType).toBe("CREDIT");
    expect(mapTransaction(raw({ transaction_type: "DEBIT" }), ctx).transactionType).toBe("DEBIT");
    expect(mapTransaction(raw({ transaction_type: "ODD" }), ctx).transactionType).toBe("DEBIT");
  });

  it("uses the currency's own exponent", () => {
    expect(mapTransaction(raw({ amount: 100, currency: "JPY", running_balance: undefined }), ctx).amount).toBe(100);
  });
});

describe("mapAccount", () => {
  it("does not carry bank details into the ledger", () => {
    const a = mapAccount(
      {
        account_id: "acc1",
        currency: "GBP",
        display_name: "Current",
        provider: { display_name: "FIRST-DIRECT" },
        account_number: { sort_code: "00-00-00", number: "12345678", iban: "GB00…" },
      },
      { tenantId: "frost" },
    );
    expect(JSON.stringify(a)).not.toContain("12345678");
    expect(JSON.stringify(a)).not.toContain("sort_code");
    expect(a.institutionName).toBe("FIRST-DIRECT");
  });
});

describe("mapBalance", () => {
  it("converts to minor units and omits what the bank did not send", () => {
    expect(mapBalance({ currency: "GBP", current: 1234.56 })).toEqual({ current: 123456 });
    expect(mapBalance({ currency: "GBP", current: 10, available: 5.5 })).toEqual({
      current: 1000,
      available: 550,
    });
  });
});

describe("handlerFor", () => {
  it("routes each known dataset", () => {
    expect(handlerFor("truelayer.transactions")).toBe("settled");
    expect(handlerFor("truelayer.card_transactions")).toBe("settled");
    expect(handlerFor("truelayer.transactions_pending")).toBe("pending");
    expect(handlerFor("truelayer.balance")).toBe("balance");
    expect(handlerFor("truelayer.info")).toBe("ignore");
  });

  it("throws on an unknown dataset instead of skipping it", () => {
    // Silently ignoring would mean a fetcher that starts producing something
    // new loses data indefinitely, with nothing to notice it by.
    expect(() => handlerFor("truelayer.somethingnew")).toThrow(/No handler/);
  });
});
