/**
 * One deterministic ledger, built from a fixed seed.
 *
 * This exists for the books migration (#108). Step 1 renames the model without
 * changing any figure, and the only way to know a figure did not change is to
 * have written it down first. So this builds a ledger big enough to exercise
 * the paths that matter — both signs, a card, an uncategorised row, a transfer
 * pair — and small enough that the numbers it produces can be read in a diff.
 *
 * Seeded rather than random: a generator that produces something different each
 * run cannot tell you a refactor moved a number, only that today differs from
 * yesterday. The seed is the fixture.
 *
 * Every value here is invented. This repository is public and the ledger is a
 * real household's — no description, amount or account below corresponds to
 * anything.
 */

import { seeded, pick, int, type Rng } from "../src/generate/gen.js";
import type { RecordedTransaction } from "../src/ledger/transaction.js";
import type { Categorisation } from "../src/categorisation/categorisation.js";
import type { AccountFacts, Movement } from "../src/reporting/balances.js";
import { recorded, assigned } from "./recorded.js";

/** Invented. Two current accounts and a card, because the card sign is inverted at the boundary. */
export const ACCOUNTS: readonly AccountFacts[] = [
  { accountId: "acc-current", isCard: false },
  { accountId: "acc-savings", isCard: false },
  // A card's series is anchored on its current balance and walked backwards;
  // the provider sends no running balance for one. Invented figure.
  { accountId: "acc-card", isCard: true, currentBalance: -42_150 },
];

/** Invented opening positions, so the running balance chain starts somewhere. */
const OPENING: Record<string, number> = {
  "acc-current": 1_250_000,
  "acc-savings": 3_400_000,
};

/** Salary is not among these: it is what an arrival is filed as, never a payment out. */
const SPEND_CATEGORIES = ["groceries", "transport", "utilities"] as const;

/** Days are midnight-stamped, as the ledger's own rows are. */
const day = (n: number): string =>
  new Date(Date.UTC(2026, 0, 1 + n)).toISOString().replace(".000Z", "Z");

export interface Sample {
  readonly transactions: readonly RecordedTransaction[];
  readonly categorisations: readonly Categorisation[];
  readonly accounts: readonly AccountFacts[];
  readonly movements: readonly Movement[];
}

/**
 * Build the sample.
 *
 * The shape of the data is deliberate rather than arbitrary: one row in fifteen
 * is left uncategorised so the provider fallback is exercised, and a matched
 * debit and credit are planted so transfer detection has something to find.
 */
export function sampleLedger(seed = 20260831): Sample {
  const rng: Rng = seeded(seed);
  const category = pick(SPEND_CATEGORIES);
  const account = pick(ACCOUNTS.map((a) => a.accountId));

  const transactions: RecordedTransaction[] = [];
  const categorisations: Categorisation[] = [];

  for (let i = 0; i < 90; i++) {
    const accountId = account(rng);
    // Salary arrives; everything else leaves. Sign is authoritative and is not
    // re-derived here — the builder is handed the amount it should store.
    const incoming = i % 11 === 0;
    const amount = incoming ? int(150_000, 320_000)(rng) : -int(250, 18_000)(rng);
    const dedupKey = `n:${i}`;
    transactions.push(
      recorded({
        accountId,
        dedupKey,
        transactionId: `txn-${i}`,
        timestamp: day(int(0, 89)(rng)),
        amount,
        description: `SAMPLE ${i}`,
        transactionType: incoming ? "CREDIT" : "DEBIT",
        providerCategory: incoming ? "CREDIT" : "PURCHASE",
        ingestedAt: day(90),
      }),
    );
    // One in fifteen stays uncategorised, so the provider fallback is covered.
    if (i % 15 !== 0) {
      categorisations.push(
        assigned(dedupKey, incoming ? "salary" : category(rng)),
      );
    }
  }

  // A planted transfer pair: the same amount out of one account and into
  // another on the same day, which is what detectTransfers looks for.
  transactions.push(
    recorded({
      accountId: "acc-current",
      dedupKey: "n:transfer-out",
      transactionId: "txn-transfer-out",
      timestamp: day(45),
      amount: -50_000,
      description: "SAMPLE TRANSFER",
      transactionType: "DEBIT",
      providerCategory: "TRANSFER",
      ingestedAt: day(90),
    }),
    recorded({
      accountId: "acc-savings",
      dedupKey: "n:transfer-in",
      transactionId: "txn-transfer-in",
      timestamp: day(45),
      amount: 50_000,
      description: "SAMPLE TRANSFER",
      transactionType: "CREDIT",
      providerCategory: "TRANSFER",
      ingestedAt: day(90),
    }),
  );

  // The running balance is the primary source for a series, so the sample has to
  // carry a real one rather than leave it undefined: without it every day is
  // `undefined` and the harness would compare nothing against nothing. Chained in
  // the same order `accountSeries` sorts by, which is what makes it consistent.
  const ordered = [...transactions].sort((a, b) =>
    a.timestamp === b.timestamp
      ? a.dedupKey.localeCompare(b.dedupKey)
      : a.timestamp < b.timestamp
        ? -1
        : 1,
  );
  const balances = new Map<string, number>(Object.entries(OPENING));
  const runningBalances = new Map<string, number>();
  for (const t of ordered) {
    if (!balances.has(t.accountId)) continue; // the card carries none
    const next = balances.get(t.accountId)! + t.amount;
    balances.set(t.accountId, next);
    runningBalances.set(t.dedupKey, next);
  }

  const movements: Movement[] = transactions.map((t) => {
    const rb = runningBalances.get(t.dedupKey);
    return {
      accountId: t.accountId,
      timestamp: t.timestamp,
      amount: t.amount,
      dedupKey: t.dedupKey,
      ...(rb === undefined ? {} : { runningBalance: rb }),
    };
  });

  return { transactions, categorisations, accounts: ACCOUNTS, movements };
}
