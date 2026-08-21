import { describe, it, expect } from "vitest";
import { generateHousehold, generatePending, seeded } from "../src/index.js";

describe("seeded", () => {
  it("gives the same sequence for the same seed", () => {
    const a = seeded(42);
    const b = seeded(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("generateHousehold", () => {
  it("is deterministic, so a failure is reproducible from the seed", () => {
    expect(generateHousehold({ seed: 1 })).toEqual(generateHousehold({ seed: 1 }));
    expect(generateHousehold({ seed: 1 })).not.toEqual(generateHousehold({ seed: 2 }));
  });

  it("emits a card purchase as POSITIVE, exactly as the provider does", () => {
    // This is the contract of these fixtures, not an accident. Tidy fixtures
    // would have ratified the sign bug instead of catching it, so if someone
    // "fixes" the generator to look sensible, this test must fail loudly.
    const { cardTransactions } = generateHousehold({ seed: 5 });
    const purchases = cardTransactions.filter((t) => t.transaction_type === "DEBIT");
    expect(purchases.length).toBeGreaterThan(0);
    expect(purchases.every((t) => t.amount > 0)).toBe(true);
  });

  it("emits a card payment as NEGATIVE, also as the provider does", () => {
    const { cardTransactions } = generateHousehold({ seed: 5 });
    const payments = cardTransactions.filter((t) => t.transaction_type === "CREDIT");
    expect(payments.length).toBeGreaterThan(0);
    expect(payments.every((t) => t.amount < 0)).toBe(true);
  });

  it("keeps ordinary accounts the right way round", () => {
    const { currentAccountTransactions } = generateHousehold({ seed: 5 });
    const debits = currentAccountTransactions.filter((t) => t.transaction_type === "DEBIT");
    const credits = currentAccountTransactions.filter((t) => t.transaction_type === "CREDIT");
    expect(debits.every((t) => t.amount < 0)).toBe(true);
    expect(credits.every((t) => t.amount > 0)).toBe(true);
  });

  it("pairs every card bill and savings sweep across two accounts", () => {
    // An internal transfer is a relationship between accounts, so it cannot be
    // exercised from one account's rows — which is where the bug hid.
    const h = generateHousehold({ seed: 5, from: "2025-01-01", to: "2025-04-01" });
    expect(h.expectedTransferPairs.length).toBe(6); // 3 months × (bill + sweep)

    for (const pair of h.expectedTransferPairs) {
      const legs = [...h.currentAccountTransactions, ...h.cardTransactions, ...h.savingsTransactions]
        .filter((t) => Math.abs(Math.abs(t.amount) - pair.amountMajor) < 0.005);
      expect(legs.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("names no real business and carries no real bank details", () => {
    const h = generateHousehold({ seed: 5 });
    const text = JSON.stringify(h);
    expect(text).toContain("SYNTHETIC-BANK");
    expect(h.currentAccount.account_number).toEqual({ sort_code: "00-00-00", number: "00000000" });
  });
});

describe("generatePending", () => {
  it("omits the running balance, as the pending endpoint does", () => {
    const pending = generatePending(4);
    expect(pending).toHaveLength(4);
    expect(pending.every((t) => t.running_balance === undefined)).toBe(true);
    expect(pending.every((t) => t.provider_transaction_id === undefined)).toBe(true);
  });
});
