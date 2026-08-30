import { describe, it, expect } from "vitest";
import { generateRawWorld } from "../src/raw-world.js";

/**
 * The relationships, asserted.
 *
 * Each of these was established from the provider's own output before it was
 * written here. A generator satisfying the schemas but not these produces JSON
 * the pipeline accepts and answers that are wrong — which is the failure mode
 * fixtures exist to prevent.
 */

const FIXED = Date.parse("2026-01-15T00:00:00Z");
const world = (seed = FIXED) =>
  generateRawWorld({ seed, tenant: "tom", months: 12 });
const of = (objs: ReturnType<typeof world>, dataset: string) =>
  objs.filter((o) => o.key.includes(`dataset=${dataset}/`));
const results = (objs: ReturnType<typeof world>, dataset: string): any[] =>
  of(objs, dataset).flatMap(
    (o) => ((o.envelope["body"] as any).results as any[]) ?? [],
  );

describe("the clock is part of the seed", () => {
  it("gives an identical world for the same seed", () => {
    expect(world()).toEqual(world());
  });

  it("gives a different world for a different moment", () => {
    expect(world()).not.toEqual(world(Date.parse("2026-02-15T00:00:00Z")));
  });

  it("anchors the data to the seed's own date", () => {
    const objs = world();
    const newest = results(objs, "truelayer.transactions")[0];
    expect(newest.timestamp.slice(0, 7)).toBe("2026-01");
  });

  it("produces a year of history when no span is asked for", () => {
    const objs = generateRawWorld({ seed: FIXED, tenant: "tom" });
    const rs = (
      objs.find((o) => o.key.includes("dataset=truelayer.transactions/"))!
        .envelope["body"] as any
    ).results as any[];
    const span =
      Date.parse(rs[0].timestamp) - Date.parse(rs[rs.length - 1]!.timestamp);
    expect(span).toBeGreaterThan(300 * 86_400_000);
  });

  it("refuses a seed that is not a moment, rather than inventing 1970", () => {
    expect(() => generateRawWorld({ seed: 1, tenant: "tom" })).toThrow(
      /epoch milliseconds/,
    );
  });
});

describe("ordering and running balance", () => {
  it("returns transactions newest-first", () => {
    const rs = results(world(), "truelayer.transactions");
    const stamps = rs.map((r) => r.timestamp);
    expect([...stamps].sort().reverse()).toEqual(stamps);
  });

  it("chains running_balance along array order, not timestamp order", () => {
    // The balance after a row, minus the balance after the next (older) row,
    // is that row's amount. That identity holds throughout the provider's own
    // output; timestamps cannot recover it, because they are day-resolution.
    const rs = results(world(), "truelayer.transactions");
    for (let i = 0; i < rs.length - 1; i += 1) {
      const delta =
        rs[i].running_balance.amount - rs[i + 1].running_balance.amount;
      expect(Math.abs(delta - rs[i].amount)).toBeLessThan(0.011);
    }
  });

  it("agrees with the balance endpoint", () => {
    const rs = results(world(), "truelayer.transactions");
    const [balance] = results(world(), "truelayer.balance");
    expect(
      Math.abs(balance.current - rs[0].running_balance.amount),
    ).toBeLessThan(0.011);
  });
});

describe("cards", () => {
  it("never carries a running balance", () => {
    for (const t of results(world(), "truelayer.card_transactions")) {
      expect(t.running_balance).toBeUndefined();
    }
  });

  it("categorises only as CREDIT or DEBIT", () => {
    // A card carries no usable provider categorisation, which is why the
    // household's own rules matter more there.
    const cats = new Set(
      results(world(), "truelayer.card_transactions").map(
        (t) => t.transaction_category,
      ),
    );
    expect([...cats].every((c) => c === "CREDIT" || c === "DEBIT")).toBe(true);
  });

  it("reports a debit positive, from the issuer's point of view", () => {
    // Reproduced on purpose: fixtures agreeing with the account convention
    // would have ratified the most expensive bug this repository has had.
    const debits = results(world(), "truelayer.card_transactions").filter(
      (t) => t.transaction_type === "DEBIT",
    );
    expect(debits.length).toBeGreaterThan(0);
    expect(debits.every((t) => t.amount > 0)).toBe(true);
  });
});

describe("pending and settled", () => {
  it("reappears as settled under both provider identifiers", () => {
    const pending = results(world(), "truelayer.transactions_pending");
    const settled = results(world(), "truelayer.transactions");
    expect(pending.length).toBeGreaterThan(0);
    for (const p of pending) {
      expect(
        settled.some(
          (s) => s.provider_transaction_id === p.provider_transaction_id,
        ),
      ).toBe(true);
      expect(
        settled.some(
          (s) =>
            s.normalised_provider_transaction_id ===
            p.normalised_provider_transaction_id,
        ),
      ).toBe(true);
    }
  });

  it("carries no running balance while pending", () => {
    for (const p of results(world(), "truelayer.transactions_pending")) {
      expect(p.running_balance).toBeUndefined();
    }
  });
});

describe("direct debits", () => {
  it("reports the previous payment positive against a negative debit", () => {
    // The sign flip is the provider's. Comparing naively matches nothing, which
    // is exactly what a correlation check on the real data found.
    const [mandate] = results(world(), "truelayer.direct_debits");
    const settled = results(world(), "truelayer.transactions");
    expect(mandate.previous_payment_amount).toBeGreaterThan(0);
    const match = settled.find(
      (t) => Math.abs(t.amount + mandate.previous_payment_amount) < 0.011,
    );
    expect(match).toBeDefined();
    expect(match.amount).toBeLessThan(0);
  });

  it("names an originator that appears in a transaction description", () => {
    const [mandate] = results(world(), "truelayer.direct_debits");
    const settled = results(world(), "truelayer.transactions");
    expect(
      settled.some((t) => (t.description as string).includes(mandate.name)),
    ).toBe(true);
  });
});

describe("amounts and direction", () => {
  it("emits major units, not minor", () => {
    // The provider sends pounds with decimals. Emitting pence here would be
    // wrong by a factor of a hundred in the conversion this codebase calls its
    // most dangerous, and every downstream total would be wrong with it.
    const rs = results(world(), "truelayer.transactions");
    for (const t of rs) {
      expect(Math.abs(t.amount)).toBeLessThan(20_000);
      expect(Math.abs(t.amount)).toBeGreaterThan(0);
      // At most two decimal places: a major-unit amount, not a scaled integer.
      expect(Math.round(t.amount * 100) / 100).toBeCloseTo(t.amount, 10);
    }
  });

  it("signs an account debit negative and a credit positive", () => {
    // The one sign convention: negative left the household. A generator that
    // emitted spending positive would ratify the inversion bug rather than
    // catch it.
    const rs = results(world(), "truelayer.transactions");
    const debits = rs.filter((t) => t.transaction_type === "DEBIT");
    const credits = rs.filter((t) => t.transaction_type === "CREDIT");
    expect(debits.length).toBeGreaterThan(0);
    expect(credits.length).toBeGreaterThan(0);
    expect(debits.every((t) => t.amount < 0)).toBe(true);
    expect(credits.every((t) => t.amount > 0)).toBe(true);
  });

  it("agrees with itself about direction across all three fields", () => {
    for (const t of results(world(), "truelayer.transactions")) {
      const debit = t.amount < 0;
      expect(t.transaction_type).toBe(debit ? "DEBIT" : "CREDIT");
      expect(t.meta.transaction_type).toBe(debit ? "Debit" : "Credit");
    }
  });

  it("categorises only within the provider's taxonomy", () => {
    const KNOWN = new Set([
      "ATM",
      "BILL_PAYMENT",
      "CREDIT",
      "DEBIT",
      "DIRECT_DEBIT",
      "INTEREST",
      "PURCHASE",
      "STANDING_ORDER",
    ]);
    const cats = results(world(), "truelayer.transactions").map(
      (t) => t.transaction_category,
    );
    expect(cats.length).toBeGreaterThan(0);
    for (const c of cats) expect(KNOWN.has(c)).toBe(true);
    // More than one kind, or the weighting has collapsed to a single branch.
    expect(new Set(cats).size).toBeGreaterThan(3);
  });

  it("describes every transaction", () => {
    for (const t of results(world(), "truelayer.transactions")) {
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(2);
    }
  });
});

describe("tenants", () => {
  it("invents one from the seed when none is given", () => {
    const objs = generateRawWorld({ seed: FIXED });
    expect(objs[0]!.key).toMatch(/^tenant=t-[0-9a-f]{10}\//);
  });

  it("gives different seeds different tenants, so two worlds cannot collide", () => {
    const a = generateRawWorld({ seed: FIXED })[0]!.key.split("/")[0];
    const b = generateRawWorld({
      seed: Date.parse("2026-03-01T00:00:00Z"),
    })[0]!.key.split("/")[0];
    expect(a).not.toBe(b);
  });
});

describe("object layout", () => {
  it("writes keys the transform can read", () => {
    for (const o of world()) {
      expect(o.key).toMatch(
        /^tenant=tom\/dataset=truelayer\.[a-z_]+\/account=[^/]+\/.+\.json\.gz$/,
      );
    }
  });

  it("wraps every response in the envelope", () => {
    for (const o of world()) {
      expect(o.envelope).toMatchObject({
        httpStatus: 200,
        captureVersion: 1,
        environment: "generated",
      });
      expect((o.envelope["body"] as any).status).toBe("Succeeded");
    }
  });
});
