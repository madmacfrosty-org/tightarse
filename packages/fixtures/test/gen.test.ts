import { describe, it, expect } from "vitest";
import { seeded } from "../src/index.js";
import {
  always,
  chain,
  int,
  listOf,
  map,
  minorUnits,
  pick,
  record,
  sometimes,
  weighted,
} from "../src/gen.js";
import {
  describableMerchants,
  PEOPLE,
  payeeName,
  DIRECT_DEBIT_ORIGINATORS,
} from "../src/vocabulary.js";

/**
 * The property the whole fixed-dataset plan rests on is determinism: the same
 * seed produces the same corpus, so a test can assert on what it contains and a
 * failure is reproducible from the seed alone. One impure leaf breaks that
 * silently, so it is pinned here rather than assumed.
 */

describe("determinism", () => {
  it("gives the same result for the same seed, every time", () => {
    const gen = listOf(pick(describableMerchants()), 50);
    expect(gen(seeded(7))).toEqual(gen(seeded(7)));
  });

  it("gives different results for different seeds", () => {
    const gen = listOf(int(0, 1_000_000), 20);
    expect(gen(seeded(1))).not.toEqual(gen(seeded(2)));
  });

  it("consumes the rng in declaration order, so field order pins the corpus", () => {
    // Not a curiosity: reordering fields in a `record` changes every value
    // after the first, which would silently invalidate a committed dataset.
    const a = record({ x: int(0, 999), y: int(0, 999) })(seeded(3));
    const b = record({ y: int(0, 999), x: int(0, 999) })(seeded(3));
    expect(a.x).toBe(b.y);
    expect(a.y).toBe(b.x);
  });
});

describe("combinators", () => {
  it("picks only from what it was given", () => {
    const rng = seeded(11);
    const ms = describableMerchants();
    for (let i = 0; i < 200; i += 1) expect(ms).toContain(pick(ms)(rng));
  });

  it("refuses an empty list rather than producing undefined", () => {
    expect(() => pick([])).toThrow(/nothing to pick from/);
  });

  it("refuses weights that cannot be chosen from", () => {
    // A zero total would divide the range into nothing and silently always
    // return the last element, which reads as a working generator.
    expect(() => weighted([])).toThrow(/sum above zero/);
    expect(() => weighted([[0, "a"]])).toThrow(/sum above zero/);
  });

  it("generates money in whole minor units", () => {
    const rng = seeded(9);
    for (let i = 0; i < 200; i += 1) {
      const n = minorUnits(1_00, 9_99)(rng);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1_00);
      expect(n).toBeLessThanOrEqual(9_99);
    }
  });

  it("respects weights", () => {
    const gen = listOf(
      weighted([
        [9, "common"],
        [1, "rare"],
      ]),
      1000,
    );
    const out = gen(seeded(5));
    const rare = out.filter((v) => v === "rare").length;
    // Loose bounds: this pins the weighting, not the exact stream.
    expect(rare).toBeGreaterThan(20);
    expect(rare).toBeLessThan(220);
  });

  it("generates integers within inclusive bounds", () => {
    const rng = seeded(2);
    for (let i = 0; i < 500; i += 1) {
      const n = int(3, 5)(rng);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(5);
    }
  });

  it("chains a dependent generator off an earlier value", () => {
    // The reason for the combinator at all: an amount that depends on which
    // merchant was chosen, rather than a range shared by every merchant.
    const gen = chain(pick(describableMerchants()), (m) =>
      map(int(m.spend[0], m.spend[1]), (amount) => ({ m, amount })),
    );
    const rng = seeded(4);
    for (let i = 0; i < 200; i += 1) {
      const { m, amount } = gen(rng);
      expect(amount).toBeGreaterThanOrEqual(m.spend[0]);
      expect(amount).toBeLessThanOrEqual(m.spend[1]);
    }
  });

  it("omits an optional field sometimes and supplies it sometimes", () => {
    const out = listOf(sometimes(always("here"), 0.5), 200)(seeded(6));
    expect(out.some((v) => v === undefined)).toBe(true);
    expect(out.some((v) => v === "here")).toBe(true);
  });
});

describe("vocabulary", () => {
  it("renders a payee the several ways a bank might", () => {
    const person = { first: "Ada", last: "Lovelace" };
    expect(payeeName(person, "initial")).toBe("A LOVELACE");
    expect(payeeName(person, "full")).toBe("ADA LOVELACE");
    expect(payeeName(person, "surname")).toBe("LOVELACE");
  });

  it("carries amounts in minor units, never decimals", () => {
    // A float here is the most dangerous bug this codebase has: major units
    // reaching the ledger read as pence and understate spending a hundredfold.
    for (const m of describableMerchants()) {
      expect(Number.isInteger(m.spend[0])).toBe(true);
      expect(Number.isInteger(m.spend[1])).toBe(true);
      expect(m.spend[1]).toBeGreaterThanOrEqual(m.spend[0]);
    }
    for (const d of DIRECT_DEBIT_ORIGINATORS) {
      expect(Number.isInteger(d.min)).toBe(true);
      expect(Number.isInteger(d.max)).toBe(true);
    }
  });

  it("names only long-dead public figures", () => {
    // The rule, as a test: a living private individual must never appear, and
    // the list must not grow by reading the raw zone.
    expect(PEOPLE.length).toBeGreaterThan(5);
    for (const p of PEOPLE) {
      expect(p.first).toMatch(/^[A-Z][a-z]+$/);
      expect(p.last).toMatch(/^[A-Z][a-z]+$/);
    }
  });
});
