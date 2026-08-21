import { describe, it, expect } from "vitest";
import { BalanceReading } from "@tightarse/domain";
import { keys, RowKind } from "../src/keys";

/**
 * Key construction, tested where it now lives.
 *
 * These moved with the code from `@tightarse/domain`. A partition key is a fact
 * about how this store lays a household's finances out, not a fact about the
 * finances, so the tests belong beside the adapter that builds them.
 */

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

describe("keys", () => {
  it("sorts a categorisation into the transaction's own partition", () => {
    // CAT sorts before EN and TX within a timestamp, so one range query returns
    // a transaction with its categorisations. No new access pattern.
    const tx = keys.transaction("frost", "2026-03-01T00:00:00Z", "d1");
    const cat = keys.categorisation("frost", "2026-03-01T00:00:00Z", "d1", "household");
    expect(cat.pk).toBe(tx.pk);
    expect(cat.sk < tx.sk).toBe(true);
    expect(RowKind.categorisation < RowKind.enrichment).toBe(true);
  });

  it("gives each set its own current row, so two sets cannot collide", () => {
    // Keyed by set rather than by version. Without the set id, two sets both at
    // version 1 produce the same key and the household set silently overwrites
    // the built-in one — and per-set rows are what make selective re-firing
    // possible at all.
    const a = keys.categorisation("frost", "2026-03-01T00:00:00Z", "d1", "household");
    const b = keys.categorisation("frost", "2026-03-01T00:00:00Z", "d1", "built-in");
    expect(a.sk).not.toBe(b.sk);
  });

  it("keeps categorisation history out of the batch read", () => {
    // The dominant read is a range over many transactions. History in that
    // partition would make it grow with churn rather than with transactions, so
    // versions live under their own partition and are fetched only on demand.
    const current = keys.categorisation("frost", "2026-03-01T00:00:00Z", "d1", "household");
    const history = keys.categorisationVersion("frost", "d1", "household", 1);
    expect(history.pk).not.toBe(current.pk);
  });

  it("orders categorisation versions numerically, so 10 follows 9", () => {
    // Zero-padded. Lexically "10" precedes "9", which would make the newest
    // version of a long-lived categorisation invisible.
    const v = (n: number) => keys.categorisationVersion("frost", "d1", "household", n).sk;
    expect([v(10), v(9), v(1)].sort()).toEqual([v(1), v(9), v(10)]);
  });

  it("returns only current rule sets from the prefix a fold run reads", () => {
    // begins_with("RULESET#") must not drag in history. The two prefixes are
    // deliberately disjoint: "RULESETH" does not begin with "RULESET#".
    const current = keys.ruleSet("frost", "household").sk;
    const history = keys.ruleSetVersion("frost", "household", 3);
    expect(current.startsWith("RULESET#")).toBe(true);
    expect(history.sk.startsWith("RULESET#")).toBe(false);
    expect(history.pk).not.toBe(keys.ruleSet("frost", "household").pk);
  });

  it("orders rule set versions numerically too", () => {
    const v = (n: number) => keys.ruleSetVersion("frost", "household", n).sk;
    expect([v(10), v(2)].sort()).toEqual([v(2), v(10)]);
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
