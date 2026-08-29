import { describe, it, expect } from "vitest";
import { generateHousehold } from "@tightarse/fixtures";
import { mapTransaction } from "@tightarse/transform";
import { dedupKey } from "@tightarse/domain";
import {
  detectTransfers,
  summarise,
  RecordedTransaction,
} from "@tightarse/domain";

/**
 * The regression test for the most expensive bug this project has had.
 *
 * Credit card amounts were stored with the provider's sign, which is inverted
 * relative to a bank account. Every card purchase counted as income, every card
 * payment as spending, and because transfer detection pairs a debit with a
 * credit while both legs of a card bill were negative, no card bill ever netted
 * out. Across five real years that overstated income by £40,554.64 and spending
 * by £42,409.38.
 *
 * It spans map → detect → summarise on purpose. Every individual piece was
 * self-consistent; the defect only existed in the seam between them, so a unit
 * test of any one of them would have passed.
 */
const household = generateHousehold({
  seed: 99,
  from: "2025-01-01",
  to: "2025-07-01",
});

/**
 * Map, then attach the dedupKey the ledger would compute on write.
 *
 * mapTransaction does not produce one — it is derived at persist time. Without
 * it every row here carried `dedupKey: undefined`, they all collided in the
 * transfer detector's `used` set, and summarise skipped the entire ledger as a
 * single transfer. The types say otherwise, but tsconfig excludes test files
 * from the build, so nothing checked them.
 */
const INGESTED_AT = "2026-01-01T00:00:00.000Z";

const map = (
  raws: ReturnType<typeof generateHousehold>["cardTransactions"],
  accountId: string,
) =>
  raws.map((r) => {
    const t = mapTransaction(r, {
      tenantId: "t",
      accountId,
      status: "settled" as const,
    });
    // Exactly what `transactionItem` adds on the way in: the identity, and when
    // we wrote it. Parsed rather than cast, so this really is the row the
    // adapter would hand back.
    return RecordedTransaction.parse({
      ...t,
      dedupKey: dedupKey(t),
      ingestedAt: INGESTED_AT,
    });
  });

/**
 * The cast that used to be here is gone.
 *
 * `mapTransaction` produces a `Transaction`; the aggregation reads what the
 * ledger stores, and the two really are different — a stored row carries the
 * dedup key the aggregation joins on, which a mapped one has never had. The
 * cast asserted a relationship between them. Building the stored row instead
 * demonstrates it, and would have caught the missing `dedupKey` described
 * above without needing the bug first.
 */
const rows: RecordedTransaction[] = [
  ...map(household.currentAccountTransactions, "acc-current-0001"),
  ...map(household.savingsTransactions, "acc-savings-0001"),
  ...map(household.cardTransactions, "card-0001"),
];

describe("card sign regression", () => {
  it("treats a card purchase as spending", () => {
    const purchases = rows.filter(
      (r) => r.accountId === "card-0001" && r.transactionType === "DEBIT",
    );
    expect(purchases.length).toBeGreaterThan(0);
    expect(purchases.every((r) => r.amount < 0)).toBe(true);
  });

  it("treats a card payment as money arriving on the card", () => {
    const payments = rows.filter(
      (r) => r.accountId === "card-0001" && r.transactionType === "CREDIT",
    );
    expect(payments.length).toBeGreaterThan(0);
    expect(payments.every((r) => r.amount > 0)).toBe(true);
  });

  it("nets out every card bill and savings sweep", () => {
    // The second-order failure: with both legs negative these never matched,
    // and only 5 of 228 real card credits were recognised as internal.
    const detected = detectTransfers(rows);
    expect(detected.pairs.length).toBe(household.expectedTransferPairs.length);

    for (const expected of household.expectedTransferPairs) {
      const minor = Math.round(expected.amountMajor * 100);
      expect(detected.pairs.some((p) => p.amount === minor)).toBe(true);
    }
  });

  it("counts no card spending as income", () => {
    // The headline symptom: card purchases inflating income.
    const summary = summarise(rows, [], {
      from: "2025-01-01",
      to: "2025-07-01",
    });
    const cardSpend = household.cardTransactions
      .filter((t) => t.transaction_type === "DEBIT")
      .reduce((s, t) => s + Math.round(t.amount * 100), 0);

    expect(cardSpend).toBeGreaterThan(0);
    // Income is salary only: every other credit is one leg of an internal
    // transfer and is excluded by netting.
    const salary = household.currentAccountTransactions
      .filter((t) => t.description === "SALARY PAYMENT")
      .reduce((s, t) => s + Math.round(t.amount * 100), 0);
    expect(summary.income).toBe(salary);
  });
});
