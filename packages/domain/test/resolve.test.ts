import { describe, it, expect } from "vitest";
import type { Categorisation } from "@tightarse/domain";
import { resolve } from "../src/categorisation/resolve.js";

const tx = {
  dedupKey: "d1",
  timestamp: "2026-03-01T00:00:00Z",
  providerCategory: "PURCHASE",
  ingestedAt: "2026-08-17T05:00:00Z",
};

const cat = (over: Partial<Categorisation>): Categorisation => ({
  dedupKey: "d1",
  timestamp: "2026-03-01T00:00:00Z",
  category: "Groceries",
  setId: "built-in",
  setVersion: 1,
  rules: [],
  version: 1,
  status: "effective",
  tags: [],
  appliedAt: "2026-08-17T06:00:00Z",
  ...over,
});

const order = [
  { setId: "household", order: 100 },
  { setId: "assisted", order: 200 },
  { setId: "built-in", order: 300 },
  { setId: "provider", order: 900 },
];

describe("resolving a transaction", () => {
  it("falls back to the provider when nothing else has categorised it", () => {
    // The state the whole ledger is in before any rule set has been applied, so
    // this is the common case rather than an edge one.
    const r = resolve(tx, [], order);
    expect(r.effective?.setId).toBe("provider");
    expect(r.effective?.category).toBe("PURCHASE");
  });

  it("has no opinion when there is nothing at all", () => {
    // Distinct from "Other". Nothing has classified this, which is what the
    // categoriser looks for.
    const r = resolve({ ...tx, providerCategory: undefined }, [], order);
    expect(r.effective).toBeUndefined();
    expect(r.bySet).toEqual([]);
    expect(r.history).toEqual([]);
  });

  it("prefers the more trusted set", () => {
    const r = resolve(tx, [cat({ setId: "built-in", category: "Groceries" }), cat({ setId: "household", category: "Fuel" })], order);
    expect(r.effective?.setId).toBe("household");
    expect(r.effective?.category).toBe("Fuel");
  });

  it("keeps what the other sets said", () => {
    // The audit question is "what did each source say", so nothing is discarded
    // — and disagreement between sources is a defect signal, not noise.
    const r = resolve(tx, [cat({ setId: "built-in", category: "Groceries" }), cat({ setId: "household", category: "Fuel" })], order);
    expect(r.bySet.map((c) => c.setId)).toEqual(["household", "built-in", "provider"]);
    expect(r.disagreeing.map((c) => c.category)).toEqual(["Groceries", "PURCHASE"]);
  });

  it("takes the newest version within a set", () => {
    const r = resolve({ ...tx, providerCategory: undefined }, [
      cat({ version: 1, category: "Groceries", status: "superseded" }),
      cat({ version: 2, category: "Fuel" }),
    ], order);
    expect(r.effective?.category).toBe("Fuel");
    expect(r.effective?.version).toBe(2);
  });

  it("orders versions numerically, so version 10 follows version 9", () => {
    const r = resolve({ ...tx, providerCategory: undefined }, [
      cat({ version: 9, category: "Groceries", status: "superseded" }),
      cat({ version: 10, category: "Fuel" }),
    ], order);
    expect(r.effective?.version).toBe(10);
  });

  it("never lets a proposal become effective", () => {
    // A pending proposal must not change what is displayed, or approving it is
    // decoration. It stays visible in history.
    const r = resolve({ ...tx, providerCategory: undefined }, [
      cat({ version: 1, category: "Groceries" }),
      cat({ version: 2, category: "Fuel", status: "proposed" }),
    ], order);
    expect(r.effective?.category).toBe("Groceries");
    expect(r.history.map((c) => c.status)).toEqual(["effective", "proposed"]);
  });

  it("returns the effective set's history oldest first", () => {
    const r = resolve({ ...tx, providerCategory: undefined }, [
      cat({ version: 2, category: "Fuel" }),
      cat({ version: 1, category: "Groceries", status: "superseded" }),
    ], order);
    expect(r.history.map((c) => c.version)).toEqual([1, 2]);
  });

  it("ranks an unranked set last rather than dropping it", () => {
    // Dropping it would hide a categorisation because somebody forgot to rank
    // its set — a silent failure. Last is merely unhelpful.
    const r = resolve({ ...tx, providerCategory: undefined }, [cat({ setId: "mystery", category: "Fuel" })], order);
    expect(r.effective?.setId).toBe("mystery");
    const both = resolve({ ...tx, providerCategory: undefined }, [
      cat({ setId: "mystery", category: "Fuel" }),
      cat({ setId: "household", category: "Groceries" }),
    ], order);
    expect(both.effective?.setId).toBe("household");
  });

  it("breaks a tie between equally ranked sets deterministically", () => {
    // Two sets given the same order is a configuration mistake rather than a
    // design, but it must not make the answer depend on row order — that would
    // be a chart or a total changing between identical requests.
    const tied = [
      { setId: "alpha", order: 100 },
      { setId: "beta", order: 100 },
    ];
    const rows = [cat({ setId: "beta", category: "Fuel" }), cat({ setId: "alpha", category: "Groceries" })];
    const a = resolve({ ...tx, providerCategory: undefined }, rows, tied);
    const b = resolve({ ...tx, providerCategory: undefined }, [...rows].reverse(), tied);
    expect(a.effective?.setId).toBe("alpha");
    expect(b.effective?.setId).toBe("alpha");
  });

  it("does not depend on the order rows arrive in", () => {
    // The ledger returns rows sorted, but this takes an array and must not
    // quietly rely on that.
    const rows = [
      cat({ setId: "built-in", category: "Groceries" }),
      cat({ setId: "household", category: "Fuel" }),
      cat({ setId: "assisted", category: "Shopping" }),
    ];
    const a = resolve(tx, rows, order);
    const b = resolve(tx, [...rows].reverse(), order);
    expect(b.bySet.map((c) => c.setId)).toEqual(a.bySet.map((c) => c.setId));
    expect(b.effective?.category).toBe(a.effective?.category);
  });
});
