import { describe, it, expect } from "vitest";
import {
  mapTransaction,
  mapAccount,
  mapBalance,
  handlerFor,
  isCardDataset,
  type RawTransaction,
  balanceReadingOf,
  stalenessSeconds,
} from "./map.js";

type Overrides<T> = { [K in keyof T]?: undefined extends T[K] ? T[K] | undefined : T[K] };

const raw = (over: Overrides<RawTransaction> = {}): RawTransaction =>
  // An optional field set to undefined is absent for our purposes; the spread
  // type cannot say that under exactOptionalPropertyTypes.
  ({
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
  }) as RawTransaction;

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

describe("fields the provider may omit", () => {
  // Written against surviving mutants, not against the source. Each of these
  // lines was fully covered and none of it was checked: the mapper could have
  // dropped merchantName, renamed the provider, or fallen back to an empty
  // institution name, and every test still passed.
  const account = { account_id: "acc1", currency: "GBP" };

  it("keeps the merchant name when there is one, and omits the key when not", () => {
    expect(mapTransaction(raw({ merchant_name: "SOME SHOP" }), ctx).merchantName).toBe("SOME SHOP");
    expect(mapTransaction(raw({ merchant_name: undefined }), ctx)).not.toHaveProperty("merchantName");
  });

  it("omits providerCategory rather than storing undefined", () => {
    expect(mapTransaction(raw({ transaction_category: "PURCHASE" }), ctx).providerCategory).toBe("PURCHASE");
    expect(mapTransaction(raw({ transaction_category: undefined }), ctx)).not.toHaveProperty("providerCategory");
  });

  it("records the provider it came from", () => {
    // A silent change here would misattribute every row in the ledger.
    expect(mapAccount(account, { tenantId: "t" }).provider).toBe("truelayer");
  });

  it("falls back to the account id when the bank sends no display name", () => {
    expect(mapAccount({ ...account, display_name: "Current" }, { tenantId: "t" }).displayName).toBe("Current");
    expect(mapAccount(account, { tenantId: "t" }).displayName).toBe("acc1");
  });

  it("says \"unknown\" rather than empty when there is no institution", () => {
    // An empty string reads as a name the bank supplied. "unknown" reads as
    // an absence, which is what it is.
    expect(mapAccount(account, { tenantId: "t" }).institutionName).toBe("unknown");
  });

  it("carries accountType and lastSyncedAt only when present", () => {
    const full = mapAccount(
      { ...account, account_type: "TRANSACTION", update_timestamp: "2026-08-01T00:00:00Z" },
      { tenantId: "t" },
    );
    expect(full.accountType).toBe("TRANSACTION");
    expect(full.lastSyncedAt).toBe("2026-08-01T00:00:00Z");

    const bare = mapAccount(account, { tenantId: "t" });
    expect(bare).not.toHaveProperty("accountType");
    expect(bare).not.toHaveProperty("lastSyncedAt");
  });

  it("omits a balance the bank did not send", () => {
    expect(mapBalance({ currency: "GBP", available: 5.5 })).toEqual({ available: 550 });
    expect(mapBalance({ currency: "GBP" })).toEqual({});
  });
});

describe("running balance, in the household's convention", () => {
  const withBalance = (amount: number) => ({
    timestamp: "2026-03-15T00:00:00Z",
    description: "SHOP",
    transaction_type: "DEBIT",
    amount: 12.99,
    currency: "GBP",
    transaction_id: "tx-1",
    running_balance: { currency: "GBP", amount },
  });

  it("passes an account's running balance through unchanged", () => {
    // For an account the provider's convention already matches ours: negative
    // means funds owed to the provider, i.e. an overdraft.
    const t = mapTransaction(withBalance(1000) as never, {
      tenantId: "frost",
      accountId: "acc-1",
      status: "settled",
      isCard: false,
    });
    expect(t.runningBalance).toBe(100_000);
  });

  it("keeps an account's overdraft negative", () => {
    const t = mapTransaction(withBalance(-250.5) as never, {
      tenantId: "frost",
      accountId: "acc-1",
      status: "settled",
      isCard: false,
    });
    expect(t.runningBalance).toBe(-25_050);
  });

  it("negates a card's running balance, because positive there means owed", () => {
    // TrueLayer: "A positive running balance amount represents money owed to
    // the provider by the cardholder." Storing that verbatim would make a
    // £2,000 card debt and £2,000 of savings the same number, and any sum
    // across accounts wrong by twice the debt.
    const t = mapTransaction(withBalance(2000) as never, {
      tenantId: "frost",
      accountId: "card-1",
      status: "settled",
      isCard: true,
    });
    expect(t.runningBalance).toBe(-200_000);
  });

  it("makes a card in credit positive, which is money the household has", () => {
    // The other direction of the same inversion: a negative card balance is
    // money owed to the cardholder.
    const t = mapTransaction(withBalance(-50) as never, {
      tenantId: "frost",
      accountId: "card-1",
      status: "settled",
      isCard: true,
    });
    expect(t.runningBalance).toBe(5_000);
  });

  it("treats an unspecified account as not a card, which is the safe default", () => {
    // Every caller passes it. If one ever stops, an account balance is left
    // alone rather than silently inverted.
    const t = mapTransaction(withBalance(1000) as never, {
      tenantId: "frost",
      accountId: "acc-1",
      status: "settled",
    });
    expect(t.runningBalance).toBe(100_000);
  });

  it("stores no running balance when the provider sent none", () => {
    const { running_balance, ...without } = withBalance(1000);
    expect(running_balance).toBeDefined();
    const t = mapTransaction(without as never, {
      tenantId: "frost",
      accountId: "acc-1",
      status: "settled",
      isCard: true,
    });
    expect(t.runningBalance).toBeUndefined();
  });
});

describe("card-ness must never reach the amount", () => {
  // The guard. Direction comes from transaction_type because the two datasets
  // disagree on sign and agree perfectly on type — measured at 8760/408 against
  // 171/20. Deriving it from card-ness instead is the obvious-looking shortcut
  // that would reintroduce a five-year inversion, so it is asserted rather than
  // left to a comment.
  const raw = (transaction_type: string) => ({
    timestamp: "2026-03-15T00:00:00Z",
    description: "SHOP",
    transaction_type,
    amount: 12.99,
    currency: "GBP",
    transaction_id: "tx-1",
  });

  it.each([
    ["DEBIT", -1299],
    ["CREDIT", 1299],
  ])("signs a %s the same whether or not it is a card", (type, expected) => {
    const asCard = mapTransaction(raw(type) as never, {
      tenantId: "frost",
      accountId: "a",
      status: "settled",
      isCard: true,
    });
    const asAccount = mapTransaction(raw(type) as never, {
      tenantId: "frost",
      accountId: "a",
      status: "settled",
      isCard: false,
    });
    expect(asCard.amount).toBe(expected);
    expect(asAccount.amount).toBe(expected);
  });
});

describe("a balance reading, kept as a series", () => {
  const raw = (current: number, available?: number) => ({
    currency: "GBP",
    current,
    ...(available !== undefined ? { available } : {}),
  });
  const ctx = { tenantId: "frost", accountId: "acc-1", fetchedAt: "2026-03-15T05:00:00.000Z" };

  it("records an account balance as the provider reports it", () => {
    const r = balanceReadingOf(raw(1234.56) as never, { ...ctx, isCard: false });
    expect(r).toMatchObject({ balance: 123_456, currency: "GBP", fetchedAt: ctx.fetchedAt });
  });

  it("negates a card balance, because positive there means owed", () => {
    // Same inversion as amount and runningBalance. Normalising here means a
    // reconciliation can subtract two readings without asking what kind of
    // account they came from.
    const r = balanceReadingOf(raw(567.9) as never, { ...ctx, isCard: true });
    expect(r.balance).toBe(-56_790);
  });

  it("negates the available figure too, so the pair stay consistent", () => {
    const r = balanceReadingOf(raw(100, 250) as never, { ...ctx, isCard: true });
    expect(r).toMatchObject({ balance: -10_000, available: -25_000 });
  });

  it("omits available when the provider does not report one, as Amex does not", () => {
    const r = balanceReadingOf(raw(100) as never, { ...ctx, isCard: true });
    expect(r).not.toHaveProperty("available");
  });

  it("keeps the fetch time, which is what makes it a series", () => {
    // Without it there is one balance per account and nothing to reconcile
    // against — which is the state this replaces.
    expect(balanceReadingOf(raw(1) as never, { ...ctx, isCard: false }).fetchedAt).toBe(ctx.fetchedAt);
  });

  it("keeps the provider's own timestamp exactly as sent", () => {
    // Stored faithfully because the card endpoint documents it not at all — the
    // OpenAPI definition gives it a datatype and no meaning. Interpreting it is
    // a separate decision from recording it.
    const r = balanceReadingOf({ ...raw(100), update_timestamp: "2026-03-15T04:28:00.000Z" } as never, {
      ...ctx,
      isCard: true,
    });
    expect(r.providerUpdatedAt).toBe("2026-03-15T04:28:00.000Z");
  });

  it("takes asOf from the provider when it gave one", () => {
    // Measured on real data: card balances are served from something refreshed
    // up to 32 minutes before we asked, while accounts were fresh in all 22
    // cases. Reconciling on our clock would put a reading on the wrong day
    // whenever a sync ran near midnight.
    const r = balanceReadingOf({ ...raw(100), update_timestamp: "2026-03-15T04:28:00.000Z" } as never, {
      ...ctx,
      isCard: true,
    });
    expect(r.asOf).toBe("2026-03-15T04:28:00.000Z");
    expect(r.asOf).not.toBe(r.fetchedAt);
  });

  it("falls back to our clock when the provider gave none", () => {
    // The field is optional on both endpoints. A reconciliation cannot be
    // written against something that might not be there, so asOf always is.
    const r = balanceReadingOf(raw(100) as never, { ...ctx, isCard: false });
    expect(r.asOf).toBe(ctx.fetchedAt);
    expect(r).not.toHaveProperty("providerUpdatedAt");
  });
});

describe("how stale a balance was", () => {
  const at = (fetchedAt: string, providerUpdatedAt?: string) => ({
    fetchedAt,
    ...(providerUpdatedAt ? { providerUpdatedAt } : {}),
  });

  it("measures how far behind our request the data was", () => {
    // 32 minutes is the worst seen in real card data, and the reason this is
    // worth watching rather than assuming.
    expect(stalenessSeconds(at("2026-03-15T05:00:00.000Z", "2026-03-15T04:28:00.000Z"))).toBe(1920);
  });

  it("reports zero when the provider gave no timestamp", () => {
    // No evidence of staleness rather than stale. Treating an absent field as
    // an old one would alarm on every provider that omits it.
    expect(stalenessSeconds(at("2026-03-15T05:00:00.000Z"))).toBe(0);
  });

  it("reports zero for data that claims to be newer than the request", () => {
    // Never seen in 45 real responses, and it would mean a clock disagreement
    // rather than freshness. A negative age would read as a healthy negative
    // number on a graph.
    expect(stalenessSeconds(at("2026-03-15T05:00:00.000Z", "2026-03-15T06:00:00.000Z"))).toBe(0);
  });
});
