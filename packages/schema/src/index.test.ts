import { describe, it, expect } from "vitest";
import { toMinorUnits, dedupKey, keys, RowKind } from "./index";

describe("toMinorUnits", () => {
  it("handles the float representations that lose a penny under truncation", () => {
    // Each of these is not exactly representable: 12.99 * 100 is
    // 1298.9999999999998, and truncating would under-report by a penny.
    expect(toMinorUnits(12.99)).toBe(1299);
    expect(toMinorUnits(-12.99)).toBe(-1299);
    expect(toMinorUnits(0.29)).toBe(29);
    expect(toMinorUnits(70.07)).toBe(7007);
    expect(toMinorUnits(-1234.56)).toBe(-123456);
  });

  it("is only guaranteed for two decimal places, which is all a bank emits", () => {
    // 1.005 * 100 is 100.49999999999999, so this rounds DOWN to 100 where a
    // human reading "£1.005" would say 100.5p. Documented rather than fixed:
    // three-decimal amounts do not occur in bank data, and the arbitrary
    // -precision arithmetic needed to handle them would buy nothing real.
    expect(toMinorUnits(1.005)).toBe(100);
  });

  it("preserves sign, which is how debit and credit are distinguished", () => {
    expect(toMinorUnits(-5)).toBe(-500);
    expect(toMinorUnits(5)).toBe(500);
    expect(toMinorUnits(0)).toBe(0);
  });

  it("rejects non-finite input rather than producing NaN pence", () => {
    expect(() => toMinorUnits(Number.NaN)).toThrow();
    expect(() => toMinorUnits(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("dedupKey", () => {
  const base = {
    accountId: "acc1",
    timestamp: "2026-08-08T00:00:00Z",
    amount: -1299,
    description: "SHOP",
  };

  it("prefers the normalised id, which survives pending to settled", () => {
    expect(
      dedupKey({ ...base, normalisedProviderTransactionId: "abc", providerTransactionId: "xyz" }),
    ).toBe("n:abc");
  });

  it("falls back through provider id to a composite hash", () => {
    expect(dedupKey({ ...base, providerTransactionId: "xyz" })).toBe("p:xyz");
    expect(dedupKey(base)).toMatch(/^c:[0-9a-f]{32}$/);
  });

  it("prefixes so a normalised id cannot collide with a provider id", () => {
    const a = dedupKey({ ...base, normalisedProviderTransactionId: "same" });
    const b = dedupKey({ ...base, providerTransactionId: "same" });
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
