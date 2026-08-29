import { describe, it, expect } from "vitest";
import { detectTransfers } from "../src/reporting/transfers.js";
import { summarise } from "../src/reporting/summary.js";
import type { RecordedTransaction } from "../src/ledger/transaction.js";
import { recorded, type Overrides } from "./recorded.js";

// The defaults this file relies on, over the shared builder's. `providerCategory`
// is blanked deliberately: these cases are about pairing and totals, and a
// provider category would put a second opinion into the resolution.
const row = (
  over: Overrides<RecordedTransaction> & { dedupKey: string },
): RecordedTransaction =>
  recorded({
    timestamp: "2026-03-15T00:00:00Z",
    amount: -50000,
    currency: "GBP",
    description: "TRANSFER",
    accountId: "accA",
    transactionType: "DEBIT",
    providerCategory: undefined,
    ...over,
  });

describe("detectTransfers", () => {
  it("pairs equal and opposite amounts across different accounts", () => {
    const d = detectTransfers([
      row({ dedupKey: "out", amount: -50000, accountId: "accA" }),
      row({ dedupKey: "in", amount: 50000, accountId: "accB" }),
    ]);
    expect(d.pairs).toHaveLength(1);
    expect(d.pairs[0]).toMatchObject({
      out: "out",
      in: "in",
      amount: 50000,
      daysApart: 0,
    });
    expect(d.totalMoved).toBe(50000);
  });

  it("never pairs within a single account", () => {
    // Equal and opposite inside one account is a correction or reversal, not a
    // transfer, and netting it would erase a real refund.
    const d = detectTransfers([
      row({ dedupKey: "a", amount: -50000, accountId: "accA" }),
      row({ dedupKey: "b", amount: 50000, accountId: "accA" }),
    ]);
    expect(d.pairs).toHaveLength(0);
  });

  it("does not pair outside the window", () => {
    const d = detectTransfers(
      [
        row({
          dedupKey: "out",
          amount: -50000,
          accountId: "accA",
          timestamp: "2026-03-01T00:00:00Z",
        }),
        row({
          dedupKey: "in",
          amount: 50000,
          accountId: "accB",
          timestamp: "2026-03-20T00:00:00Z",
        }),
      ],
      { windowDays: 3 },
    );
    expect(d.pairs).toHaveLength(0);
  });

  it("uses each leg at most once", () => {
    // One debit, two candidate credits. Matching both would erase spending that
    // genuinely happened.
    const d = detectTransfers([
      row({ dedupKey: "out", amount: -50000, accountId: "accA" }),
      row({ dedupKey: "in1", amount: 50000, accountId: "accB" }),
      row({ dedupKey: "in2", amount: 50000, accountId: "accC" }),
    ]);
    expect(d.pairs).toHaveLength(1);
    expect(d.keys.size).toBe(2);
  });

  it("matches nearest in time when the same amount moves repeatedly", () => {
    // A monthly standing order of the same value would otherwise pair January's
    // debit with June's credit and leave the real pairs unmatched.
    const d = detectTransfers(
      [
        row({
          dedupKey: "outJan",
          amount: -50000,
          accountId: "accA",
          timestamp: "2026-01-05T00:00:00Z",
        }),
        row({
          dedupKey: "inJan",
          amount: 50000,
          accountId: "accB",
          timestamp: "2026-01-05T00:00:00Z",
        }),
        row({
          dedupKey: "outFeb",
          amount: -50000,
          accountId: "accA",
          timestamp: "2026-02-05T00:00:00Z",
        }),
        row({
          dedupKey: "inFeb",
          amount: 50000,
          accountId: "accB",
          timestamp: "2026-02-05T00:00:00Z",
        }),
      ],
      { windowDays: 60 },
    );
    expect(d.pairs).toHaveLength(2);
    const pairs = d.pairs.map((p) => `${p.out}->${p.in}`).sort();
    expect(pairs).toEqual(["outFeb->inFeb", "outJan->inJan"]);
  });

  it("ignores same-signed amounts", () => {
    const d = detectTransfers([
      row({ dedupKey: "a", amount: -50000, accountId: "accA" }),
      row({ dedupKey: "b", amount: -50000, accountId: "accB" }),
    ]);
    expect(d.pairs).toHaveLength(0);
  });
});

describe("netting invariant", () => {
  it("changes gross income and spend but never the net position", () => {
    // Each transfer removes an equal debit and credit, so net must be
    // untouched. Measured against the real ledger: gross fell by £574,551 on
    // each side and net stayed at -£51,834.45. If netting ever moves net, the
    // matcher has paired two unrelated transactions.
    const rows: RecordedTransaction[] = [
      row({ dedupKey: "out", amount: -50000, accountId: "accA" }),
      row({ dedupKey: "in", amount: 50000, accountId: "accB" }),
      row({
        dedupKey: "shop",
        amount: -1299,
        accountId: "accA",
        description: "SHOP",
      }),
      row({
        dedupKey: "pay",
        amount: 200000,
        accountId: "accA",
        description: "SALARY",
      }),
    ];
    const range = { from: "2026-01-01", to: "2026-12-31" };

    const netted = summarise(rows, [], range);
    const raw = summarise(rows, [], range, { transfers: false });

    expect(netted.net).toBe(raw.net);
    expect(netted.income).toBe(raw.income - 50000);
    expect(netted.spend).toBe(raw.spend + 50000);
    expect(netted.transferCount).toBe(2);
    expect(netted.transferTotal).toBe(50000);
    expect(netted.internalTransfersNetted).toBe(true);
  });

  it("keeps transfer legs out of category totals", () => {
    const rows: RecordedTransaction[] = [
      row({
        dedupKey: "out",
        amount: -50000,
        accountId: "accA",
        providerCategory: "TRANSFER",
      }),
      row({
        dedupKey: "in",
        amount: 50000,
        accountId: "accB",
        providerCategory: "TRANSFER",
      }),
      row({
        dedupKey: "shop",
        amount: -1299,
        accountId: "accA",
        providerCategory: "PURCHASE",
      }),
    ];
    const s = summarise(rows, [], { from: "2026-01-01", to: "2026-12-31" });
    expect(s.byCategory.map((c) => c.category)).toEqual(["PURCHASE"]);
  });
});

/**
 * Written against surviving mutants. Every case below is a line the existing
 * tests executed without checking — the matcher decides what counts as spending
 * rather than money moving between your own accounts, so a wrong answer here
 * misstates the totals rather than crashing.
 */
describe("detectTransfers, the edges", () => {
  const at = (day: number) =>
    `2026-03-${String(day).padStart(2, "0")}T00:00:00Z`;

  it("ignores zero-amount rows instead of pairing them with each other", () => {
    // Two zeroes are equal and opposite in the most useless possible way.
    const d = detectTransfers([
      row({ dedupKey: "z1", amount: 0, accountId: "accA" }),
      row({ dedupKey: "z2", amount: 0, accountId: "accB" }),
    ]);
    expect(d.pairs).toHaveLength(0);
  });

  it("never pairs an amount that appears only once", () => {
    const d = detectTransfers([
      row({ dedupKey: "lonely", amount: -1234, accountId: "accA" }),
    ]);
    expect(d.pairs).toHaveLength(0);
  });

  it("needs one of each direction, not two of the same", () => {
    // Two debits of the same size in different accounts is two purchases, not
    // a transfer. Same for two credits.
    expect(
      detectTransfers([
        row({ dedupKey: "d1", amount: -5000, accountId: "accA" }),
        row({ dedupKey: "d2", amount: -5000, accountId: "accB" }),
      ]).pairs,
    ).toHaveLength(0);
    expect(
      detectTransfers([
        row({ dedupKey: "c1", amount: 5000, accountId: "accA" }),
        row({ dedupKey: "c2", amount: 5000, accountId: "accB" }),
      ]).pairs,
    ).toHaveLength(0);
  });

  it("pairs a credit that lands before its debit", () => {
    // The gap is measured absolutely. Banks do not agree on which leg posts
    // first, and a card payment often shows on the card before the account.
    const d = detectTransfers([
      row({
        dedupKey: "out",
        amount: -7500,
        accountId: "accA",
        timestamp: at(10),
      }),
      row({
        dedupKey: "in",
        amount: 7500,
        accountId: "accB",
        timestamp: at(8),
      }),
    ]);
    expect(d.pairs).toHaveLength(1);
  });

  it("pairs at the window boundary and not beyond it", () => {
    const pair = (daysApart: number) =>
      detectTransfers([
        row({
          dedupKey: "out",
          amount: -900,
          accountId: "accA",
          timestamp: at(10),
        }),
        row({
          dedupKey: "in",
          amount: 900,
          accountId: "accB",
          timestamp: at(10 + daysApart),
        }),
      ]).pairs;
    expect(pair(3)).toHaveLength(1);
    expect(pair(4)).toHaveLength(0);
  });

  it("honours a widened window", () => {
    const d = detectTransfers(
      [
        row({
          dedupKey: "out",
          amount: -900,
          accountId: "accA",
          timestamp: at(10),
        }),
        row({
          dedupKey: "in",
          amount: 900,
          accountId: "accB",
          timestamp: at(16),
        }),
      ],
      { windowDays: 7 },
    );
    expect(d.pairs).toHaveLength(1);
  });

  it("pairs each leg with its nearest counterpart, not the first it finds", () => {
    // A monthly standing order of the same amount. Without nearest-first
    // matching, March's debit pairs with a credit weeks away and the real
    // pairs are left unmatched — which shows up as phantom spending.
    const d = detectTransfers([
      row({
        dedupKey: "out1",
        amount: -50000,
        accountId: "accA",
        timestamp: at(1),
      }),
      row({
        dedupKey: "in1",
        amount: 50000,
        accountId: "accB",
        timestamp: at(2),
      }),
      row({
        dedupKey: "out2",
        amount: -50000,
        accountId: "accA",
        timestamp: at(20),
      }),
      row({
        dedupKey: "in2",
        amount: 50000,
        accountId: "accB",
        timestamp: at(21),
      }),
    ]);
    expect(d.pairs).toHaveLength(2);
    for (const p of d.pairs) {
      expect(p.daysApart).toBeLessThanOrEqual(1);
    }
    expect(d.pairs.map((p) => [p.out, p.in]).sort()).toEqual([
      ["out1", "in1"],
      ["out2", "in2"],
    ]);
  });

  it("reports the amount moved as a positive figure", () => {
    const d = detectTransfers([
      row({ dedupKey: "out", amount: -12345, accountId: "accA" }),
      row({ dedupKey: "in", amount: 12345, accountId: "accB" }),
    ]);
    expect(d.pairs[0]!.amount).toBe(12345);
    expect(d.totalMoved).toBe(12345);
  });
});

describe("nearest-first matching", () => {
  const at = (day: number) =>
    `2026-03-${String(day).padStart(2, "0")}T00:00:00Z`;

  it("prefers the closest counterpart even when array order suggests otherwise", () => {
    // Constructed so the first pairing the loops reach is NOT the nearest:
    // out1 meets in1 first at three days apart, while in2 is one day away.
    // Without the sort both still pair — inside the window — but against the
    // wrong partners, and `daysApart` is the only thing that shows it.
    const d = detectTransfers([
      row({
        dedupKey: "out1",
        amount: -4200,
        accountId: "accA",
        timestamp: at(1),
      }),
      row({
        dedupKey: "out2",
        amount: -4200,
        accountId: "accA",
        timestamp: at(3),
      }),
      row({
        dedupKey: "in1",
        amount: 4200,
        accountId: "accB",
        timestamp: at(4),
      }),
      row({
        dedupKey: "in2",
        amount: 4200,
        accountId: "accB",
        timestamp: at(2),
      }),
    ]);

    expect(d.pairs).toHaveLength(2);
    expect(d.pairs.every((p) => p.daysApart <= 1)).toBe(true);
    expect(d.pairs.map((p) => `${p.out}->${p.in}`).sort()).toEqual([
      "out1->in2",
      "out2->in1",
    ]);
  });
});
