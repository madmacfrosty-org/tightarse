import { describe, it, expect } from "vitest";
import { toMinorUnits, minorUnitExponent, assertSingleCurrency, dedupKey, BalanceReading } from "../src/index.js";

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

