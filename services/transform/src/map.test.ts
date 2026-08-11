import { describe, it, expect } from "vitest";
import {
  mapTransaction,
  mapAccount,
  mapBalance,
  handlerFor,
  isCardDataset,
  type RawTransaction,
} from "./map.js";

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
    // A credit, not a debit: direction now comes from transaction_type, so a
    // positive amount on a DEBIT row is a card purchase and stays negative.
    expect(mapTransaction(raw({ amount: 0.29, transaction_type: "CREDIT" }), ctx).amount).toBe(29);
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
    const yen = (over: Partial<RawTransaction>) =>
      mapTransaction(raw({ amount: 100, currency: "JPY", running_balance: undefined, ...over }), ctx);
    expect(yen({ transaction_type: "CREDIT" }).amount).toBe(100);
    expect(yen({ transaction_type: "DEBIT" }).amount).toBe(-100);
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

describe("card identification", () => {
  const raw = { account_id: "amex1", currency: "GBP", display_name: "Gold" };

  it("marks cards from the endpoint, not from the balances", () => {
    // Amex returns no available balance, so any rule comparing available to
    // current classifies it as a bank account and shows the debt as cash.
    expect(mapAccount(raw, { tenantId: "t", isCard: true }).isCard).toBe(true);
    expect(mapAccount(raw, { tenantId: "t" }).isCard).toBe(false);
  });

  it("derives card-ness from every card dataset", () => {
    expect(isCardDataset("truelayer.cards")).toBe(true);
    expect(isCardDataset("truelayer.card")).toBe(true);
    expect(isCardDataset("truelayer.card_balance")).toBe(true);
    expect(isCardDataset("truelayer.accounts")).toBe(false);
    expect(isCardDataset("truelayer.balance")).toBe(false);
  });
});

describe("sign convention", () => {
  // Shapes taken verbatim from the two live datasets. The card rows are the
  // reason this exists: TrueLayer reports them from the issuer's point of view.
  const card = (over: Partial<RawTransaction>) =>
    mapTransaction({ ...raw(), ...over }, { tenantId: "t", accountId: "card", status: "settled" });

  it("makes a card purchase spending, not income", () => {
    // Raw: amount 5233, type DEBIT — positive because it increases what you owe.
    const t = card({ amount: 5233, transaction_type: "DEBIT", description: "THE KBB COMPANY LTD" });
    expect(t.amount).toBe(-523300);
    expect(t.transactionType).toBe("DEBIT");
  });

  it("makes a card payment money in, so it can pair with the account debit", () => {
    // Raw: amount -5779.7, type CREDIT — "PAYMENT RECEIVED - THANK YOU".
    const t = card({ amount: -5779.7, transaction_type: "CREDIT", description: "PAYMENT RECEIVED" });
    expect(t.amount).toBe(577970);
    expect(t.transactionType).toBe("CREDIT");
  });

  it("leaves ordinary account rows exactly as they were", () => {
    const debit = mapTransaction(
      { ...raw(), amount: -3339.39, transaction_type: "DEBIT" },
      { tenantId: "t", accountId: "acc", status: "settled" },
    );
    const credit = mapTransaction(
      { ...raw(), amount: 2500, transaction_type: "CREDIT" },
      { tenantId: "t", accountId: "acc", status: "settled" },
    );
    expect(debit.amount).toBe(-333939);
    expect(credit.amount).toBe(250000);
  });

  it("pairs both legs of a card bill payment once signs agree", () => {
    // The whole point: £3,339.39 leaves the current account and lands on the
    // card. Before normalisation both legs were negative and never matched.
    const out = mapTransaction(
      { ...raw(), amount: -3339.39, transaction_type: "DEBIT", description: "AMERICAN EXPRESS" },
      { tenantId: "t", accountId: "current", status: "settled" },
    );
    const onCard = card({ amount: -3339.39, transaction_type: "CREDIT", description: "PAYMENT RECEIVED" });
    expect(out.amount).toBe(-333939);
    expect(onCard.amount).toBe(333939);
    expect(out.amount + onCard.amount).toBe(0);
  });
});
