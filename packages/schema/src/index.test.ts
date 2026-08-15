import { describe, it, expect } from "vitest";
import { toMinorUnits, minorUnitExponent, assertSingleCurrency, dedupKey, keys, RowKind,
  BalanceReading,
} from "./index";

describe("toMinorUnits", () => {
  it("handles the float representations that lose a penny under truncation", () => {
    // Each of these is not exactly representable: 12.99 * 100 is
    // 1298.9999999999998, and truncating would under-report by a penny.
    expect(toMinorUnits(12.99, "GBP")).toBe(1299);
    expect(toMinorUnits(-12.99, "GBP")).toBe(-1299);
    expect(toMinorUnits(0.29, "GBP")).toBe(29);
    expect(toMinorUnits(70.07, "GBP")).toBe(7007);
    expect(toMinorUnits(-1234.56, "GBP")).toBe(-123456);
  });

  it("uses the currency's own exponent, not a hardcoded 100", () => {
    // The failure this guards against is silent and large: treating JPY as
    // 2-decimal overstates every yen amount a hundredfold.
    expect(toMinorUnits(100, "JPY")).toBe(100);
    expect(toMinorUnits(1.5, "KWD")).toBe(1500);
    expect(toMinorUnits(1.5, "GBP")).toBe(150);
    expect(minorUnitExponent("JPY")).toBe(0);
    expect(minorUnitExponent("KWD")).toBe(3);
    expect(minorUnitExponent("gbp")).toBe(2);
    expect(minorUnitExponent("ZZZ")).toBe(2);
  });

  it("is only guaranteed for two decimal places, which is all a bank emits", () => {
    // 1.005 * 100 is 100.49999999999999, so this rounds DOWN to 100 where a
    // human reading "£1.005" would say 100.5p. Documented rather than fixed:
    // three-decimal amounts do not occur in bank data, and the arbitrary
    // -precision arithmetic needed to handle them would buy nothing real.
    expect(toMinorUnits(1.005, "GBP")).toBe(100);
  });

  it("preserves sign, which is how debit and credit are distinguished", () => {
    expect(toMinorUnits(-5, "GBP")).toBe(-500);
    expect(toMinorUnits(5, "GBP")).toBe(500);
    expect(toMinorUnits(0, "GBP")).toBe(0);
  });

  it("rejects non-finite input rather than producing NaN pence", () => {
    expect(() => toMinorUnits(Number.NaN, "GBP")).toThrow();
    expect(() => toMinorUnits(Number.POSITIVE_INFINITY, "GBP")).toThrow();
  });
});

describe("dedupKey", () => {
  const base = {
    accountId: "acc1",
    timestamp: "2026-08-08T00:00:00Z",
    amount: -1299,
    description: "SHOP",
  };

  it("records which identifier was available in the prefix", () => {
    expect(dedupKey({ ...base, normalisedProviderTransactionId: "abc" })).toMatch(/^n:[0-9a-f]{32}$/);
    expect(dedupKey({ ...base, providerTransactionId: "xyz" })).toMatch(/^p:[0-9a-f]{32}$/);
    expect(dedupKey(base)).toMatch(/^c:[0-9a-f]{32}$/);
  });

  it("prefixes so a normalised id cannot collide with a provider id", () => {
    const a = dedupKey({ ...base, normalisedProviderTransactionId: "same" });
    const b = dedupKey({ ...base, providerTransactionId: "same" });
    expect(a).not.toBe(b);
  });

  it("separates transactions that share a provider id but differ in content", () => {
    // Measured: 191 card transactions carried only 160 distinct normalised ids,
    // and colliding rows had entirely different amounts. Keying on the id alone
    // would have merged them and lost money from the ledger.
    const a = dedupKey({ ...base, normalisedProviderTransactionId: "shared", amount: -1142 });
    const b = dedupKey({ ...base, normalisedProviderTransactionId: "shared", amount: -38185 });
    expect(a).not.toBe(b);
  });

  it("separates identical-looking transactions that carry different ids", () => {
    // The mirror failure: 9,168 account rows produced only 9,028 distinct
    // timestamp+amount+description keys. People buy the same thing twice a day.
    const a = dedupKey({ ...base, normalisedProviderTransactionId: "id-1" });
    const b = dedupKey({ ...base, normalisedProviderTransactionId: "id-2" });
    expect(a).not.toBe(b);
  });

  it("is stable for identical input and differs when any component changes", () => {
    expect(dedupKey(base)).toBe(dedupKey({ ...base }));
    expect(dedupKey(base)).not.toBe(dedupKey({ ...base, amount: -1300 }));
    expect(dedupKey(base)).not.toBe(dedupKey({ ...base, description: "OTHER" }));
  });
});

describe("keys", () => {
  const t = "frost";
  const ts = "2026-08-08T00:00:00Z";

  it("puts transactions and enrichments in one partition", () => {
    expect(keys.transaction(t, ts, "n:a").pk).toBe(keys.enrichment(t, ts, "n:a").pk);
  });

  it("orders by timestamp before kind, so a range query returns both", () => {
    // The kind marker sits AFTER the timestamp precisely so that a single
    // `between` on the sort key spans transactions and enrichments together.
    const tx = keys.transaction(t, ts, "n:a").sk;
    const en = keys.enrichment(t, ts, "n:a").sk;
    expect(tx.startsWith(ts)).toBe(true);
    expect(en.startsWith(ts)).toBe(true);
    expect(tx).toContain(`#${RowKind.transaction}#`);
    expect(en).toContain(`#${RowKind.enrichment}#`);
  });

  it("sorts chronologically as strings, which is what the range query relies on", () => {
    const early = keys.transaction(t, "2021-08-09T00:00:00Z", "n:a").sk;
    const late = keys.transaction(t, "2026-08-09T00:00:00Z", "n:a").sk;
    expect([late, early].sort()).toEqual([early, late]);
  });

  it("keeps a household in one partition space so transfers can be matched", () => {
    // Both sides of an internal transfer must be queryable together, which is
    // why a tenant is a household rather than a person.
    expect(keys.transaction(t, ts, "n:a").pk).toBe(keys.transaction(t, ts, "n:b").pk);
  });
});

describe("assertSingleCurrency", () => {
  it("refuses to let a mixed-currency set be summed", () => {
    // Silently adding yen to pounds yields a plausible wrong number, which is
    // worse than an error in a finance application.
    expect(() => assertSingleCurrency([{ currency: "GBP" }, { currency: "JPY" }])).toThrow(
      /Cannot aggregate across currencies/,
    );
  });

  it("passes a uniform set through and reports the currency", () => {
    expect(assertSingleCurrency([{ currency: "GBP" }, { currency: "GBP" }])).toBe("GBP");
    expect(assertSingleCurrency([])).toBeNull();
  });
});

describe("balance readings", () => {
  it("keys one row per fetch, in its own partition per account", () => {
    // Its own partition so reading a series is one query, and so it cannot
    // collide with the account row it describes.
    expect(keys.balanceReading("frost", "acc-1", "2026-03-15T04:28:00.000Z", "2026-03-15T05:00:00.000Z")).toEqual({
      pk: "T#frost#BAL#acc-1",
      // Sorted by when the balance was true, made unique by when we asked.
      sk: "2026-03-15T04:28:00.000Z#2026-03-15T05:00:00.000Z",
    });
  });

  it("sorts readings oldest first, because the sort key is the fetch time", () => {
    // Reconciliation walks consecutive readings, so their order has to come
    // from the key rather than from sorting after the fact.
    const at = (t: string) => keys.balanceReading("frost", "acc-1", t, t).sk;
    const stamps = [at("2026-03-15T05:00:00.000Z"), at("2026-01-02T05:00:00.000Z"), at("2026-02-01T05:00:00.000Z")];
    expect([...stamps].sort()).toEqual([stamps[1], stamps[2], stamps[0]]);
  });

  it("keeps two fetches of the same cached balance as separate rows", () => {
    // Card data can be served from something refreshed up to half an hour
    // earlier, so two syncs can legitimately return the same provider
    // timestamp. Keying on that alone would make the second write overwrite the
    // first and lose the fact that we asked twice.
    const cached = "2026-03-15T04:28:00.000Z";
    const first = keys.balanceReading("frost", "card-1", cached, "2026-03-15T05:00:00.000Z");
    const second = keys.balanceReading("frost", "card-1", cached, "2026-03-16T05:00:00.000Z");
    expect(first.sk).not.toBe(second.sk);
    // And they still sort together, because the provider timestamp leads.
    expect([second.sk, first.sk].sort()).toEqual([first.sk, second.sk]);
  });

  it("accepts a negative balance, which is how money owed is written", () => {
    // A card's reading is negated on the way in, and a current account can be
    // overdrawn. Both are negative and both are valid.
    const parsed = BalanceReading.parse({
      tenantId: "frost",
      accountId: "card-1",
      fetchedAt: "2026-03-15T05:00:00.000Z",
      asOf: "2026-03-15T05:00:00.000Z",
      balance: -56_790,
      currency: "GBP",
    });
    expect(parsed.balance).toBe(-56_790);
  });

  it("allows a reading with no available figure, as Amex reports none", () => {
    const parsed = BalanceReading.parse({
      tenantId: "frost",
      accountId: "card-1",
      fetchedAt: "2026-03-15T05:00:00.000Z",
      asOf: "2026-03-15T05:00:00.000Z",
      balance: -100,
      currency: "GBP",
    });
    expect(parsed).not.toHaveProperty("available");
  });

  it("carries a dirty flag and how far off it was", () => {
    // The number is kept and marked rather than hidden or corrected. Anything
    // derived from a dirty reading is dirty too.
    const parsed = BalanceReading.parse({
      tenantId: "frost",
      accountId: "acc-1",
      fetchedAt: "2026-03-15T05:00:00.000Z",
      asOf: "2026-03-15T05:00:00.000Z",
      balance: 100,
      currency: "GBP",
      dirty: true,
      discrepancy: -250,
    });
    expect(parsed).toMatchObject({ dirty: true, discrepancy: -250 });
  });

  it("refuses a reading with no fetch time, which would not be a series", () => {
    const without = { tenantId: "frost", accountId: "acc-1", asOf: "2026-03-15T05:00:00.000Z", balance: 1, currency: "GBP" };
    expect(BalanceReading.safeParse(without).success).toBe(false);
  });
});
