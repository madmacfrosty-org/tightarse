import { seeded } from "@tightarse/domain";
/**
 * Synthetic fixture generator.
 *
 * The repo is public, so no real transaction may ever appear in a test. This
 * exists to make the right thing the easy thing: generating a plausible
 * household should be less effort than pasting a real one.
 *
 * ## What these fixtures imitate
 *
 * **The provider's raw payloads, quirks included — not our clean domain model.**
 * That distinction is the whole point. TrueLayer reports each resource from that
 * resource's own point of view, so a credit card's DEBIT is POSITIVE, because a
 * purchase increases what you owe, while a current account's DEBIT is negative.
 * We stored that verbatim for months. Every card purchase counted as income,
 * every card payment as spending, and neither leg of a card bill payment could
 * pair with the other, because transfer detection matches a debit to a credit
 * and both legs were negative. Five years of totals were out by £40k either way.
 *
 * A generator emitting tidy, self-consistent data would not have caught it —
 * and would have quietly certified the bug as correct. So `cardTransactions`
 * emits the inverted sign deliberately, and there are tests asserting it does.
 *
 * Everything is seeded and deterministic: same seed, same household, so a
 * failure is reproducible from the seed alone.
 */

/** A transaction in TrueLayer's wire shape. */
export * from "@tightarse/domain";
export * from "./raw-world.js";
export * from "@tightarse/domain";

export interface RawTransaction {
  timestamp: string;
  description: string;
  transaction_type: "DEBIT" | "CREDIT";
  transaction_category: string;
  transaction_classification: string[];
  amount: number;
  currency: string;
  transaction_id: string;
  provider_transaction_id?: string;
  normalised_provider_transaction_id?: string;
  merchant_name?: string;
  running_balance?: { currency: string; amount: number };
}

export interface RawAccount {
  account_id: string;
  account_type?: string;
  display_name: string;
  currency: string;
  update_timestamp: string;
  provider: { display_name: string; provider_id: string };
  account_number?: Record<string, string>;
}

/**
 * Invented merchants that read like UK bank descriptions — capitals, a town, a
 * trailing country code — without naming a real business anyone could mistake
 * for a real purchase.
 */
const MERCHANTS: ReadonlyArray<{ name: string; category: string; min: number; max: number }> = [
  { name: "GREENFIELD GROCERS BRISTOL GB", category: "PURCHASE", min: 4.2, max: 88.5 },
  { name: "TWO OAKS COFFEE LEEDS GB", category: "PURCHASE", min: 2.4, max: 14.8 },
  { name: "NORTHGATE FUEL DERBY GB", category: "PURCHASE", min: 38.0, max: 96.0 },
  { name: "PILLARBOX BOOKS YORK GB", category: "PURCHASE", min: 6.99, max: 42.0 },
  { name: "HARBOUR VIEW BISTRO HULL GB", category: "PURCHASE", min: 18.0, max: 130.0 },
  { name: "CLOUDWELL HOSTING 0800 118822", category: "PURCHASE", min: 4.99, max: 24.99 },
  { name: "WESTFERRY HARDWARE LONDON GB", category: "PURCHASE", min: 7.5, max: 210.0 },
  { name: "LAMPLIGHT PHARMACY BATH GB", category: "PURCHASE", min: 3.1, max: 29.4 },
  { name: "KESTREL CYCLES OXFORD GB", category: "PURCHASE", min: 12.0, max: 480.0 },
  { name: "MARLOW & SONS BUTCHERS ELY GB", category: "PURCHASE", min: 9.0, max: 64.0 },
];

const DIRECT_DEBITS: ReadonlyArray<{ name: string; amount: number }> = [
  { name: "RIVERSIDE COUNCIL TAX", amount: 184.0 },
  { name: "NORTHERN ENERGY DD", amount: 121.5 },
  { name: "CLEARWATER UTILITIES", amount: 38.75 },
  { name: "BROADREACH BROADBAND", amount: 32.99 },
];

export interface HouseholdOptions {
  seed?: number;
  /** Inclusive start of the generated period, ISO date. */
  from?: string;
  /** Exclusive end, ISO date. */
  to?: string;
  /** Roughly how many card purchases to emit per month. */
  cardPurchasesPerMonth?: number;
}

export interface Household {
  currentAccount: RawAccount;
  savingsAccount: RawAccount;
  card: RawAccount;
  /** Raw payload for GET /data/v1/accounts/{id}/transactions. */
  currentAccountTransactions: RawTransaction[];
  savingsTransactions: RawTransaction[];
  /** Raw payload for GET /data/v1/cards/{id}/transactions — inverted signs. */
  cardTransactions: RawTransaction[];
  /**
   * Card bill payments, as the pairs a correct implementation must net out:
   * one leg leaves the current account, the other lands on the card.
   */
  expectedTransferPairs: Array<{ amountMajor: number; timestamp: string }>;
}

const DAY_MS = 86_400_000;

function iso(t: number): string {
  return new Date(t).toISOString();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * A whole plausible household: a current account with salary and direct debits,
 * a savings account, and a credit card whose bill is paid monthly from the
 * current account.
 *
 * The card payments are the reason this generates a *household* rather than a
 * bag of transactions. An internal transfer only exists as a relationship
 * between two accounts, so transfer detection cannot be tested against a single
 * account's rows, and that is precisely where the expensive bug lived.
 */
export function generateHousehold(opts: HouseholdOptions = {}): Household {
  const rand = seeded(opts.seed ?? 20260812);
  const from = Date.parse(opts.from ?? "2025-01-01T00:00:00.000Z");
  const to = Date.parse(opts.to ?? "2026-01-01T00:00:00.000Z");
  const perMonth = opts.cardPurchasesPerMonth ?? 12;

  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const between = (min: number, max: number) => round2(min + rand() * (max - min));

  const provider = { display_name: "SYNTHETIC-BANK", provider_id: "ob-synthetic" };
  const currentAccount: RawAccount = {
    account_id: "acc-current-0001",
    account_type: "TRANSACTION",
    display_name: "Everyday Account",
    currency: "GBP",
    update_timestamp: iso(to),
    provider,
    // Present so tests can assert the mapper drops it rather than storing it.
    account_number: { sort_code: "00-00-00", number: "00000000" },
  };
  const savingsAccount: RawAccount = {
    account_id: "acc-savings-0001",
    account_type: "SAVINGS",
    display_name: "Rainy Day",
    currency: "GBP",
    update_timestamp: iso(to),
    provider,
  };
  const card: RawAccount = {
    account_id: "card-0001",
    display_name: "Synthetic Rewards Card",
    currency: "GBP",
    update_timestamp: iso(to),
    provider,
  };

  const currentAccountTransactions: RawTransaction[] = [];
  const savingsTransactions: RawTransaction[] = [];
  const cardTransactions: RawTransaction[] = [];
  const expectedTransferPairs: Household["expectedTransferPairs"] = [];

  let id = 0;
  const nextId = () => `syn-${String(++id).padStart(6, "0")}`;

  // A current account keeps a running balance; a card, in this shape, does not.
  let balance = 2400.0;

  for (let month = new Date(from); month.getTime() < to; month.setUTCMonth(month.getUTCMonth() + 1)) {
    const monthStart = month.getTime();
    const inMonth = (day: number) => monthStart + day * DAY_MS;

    // Salary on the 28th.
    const salary = between(2800, 3200);
    balance = round2(balance + salary);
    currentAccountTransactions.push({
      timestamp: iso(inMonth(27)),
      description: "SALARY PAYMENT",
      transaction_type: "CREDIT",
      transaction_category: "CREDIT",
      transaction_classification: [],
      amount: salary,
      currency: "GBP",
      transaction_id: nextId(),
      provider_transaction_id: nextId(),
      running_balance: { currency: "GBP", amount: balance },
    });

    for (const [i, dd] of DIRECT_DEBITS.entries()) {
      balance = round2(balance - dd.amount);
      currentAccountTransactions.push({
        timestamp: iso(inMonth(2 + i)),
        description: dd.name,
        transaction_type: "DEBIT",
        transaction_category: "DIRECT_DEBIT",
        transaction_classification: [],
        // A current account's DEBIT is negative.
        amount: -dd.amount,
        currency: "GBP",
        transaction_id: nextId(),
        provider_transaction_id: nextId(),
        running_balance: { currency: "GBP", amount: balance },
      });
    }

    // Card spending through the month, and the bill paid at the end of it.
    let billed = 0;
    for (let p = 0; p < perMonth; p++) {
      const m = pick(MERCHANTS);
      const amount = between(m.min, m.max);
      billed = round2(billed + amount);
      cardTransactions.push({
        timestamp: iso(inMonth(1 + Math.floor(rand() * 26))),
        description: m.name,
        transaction_type: "DEBIT",
        transaction_category: m.category,
        transaction_classification: [],
        // THE QUIRK, ON PURPOSE. A card purchase is POSITIVE: it increases what
        // the issuer is owed. Emitting -amount here would make these fixtures
        // agree with a bug we have already paid for once.
        amount,
        currency: "GBP",
        transaction_id: nextId(),
        provider_transaction_id: nextId(),
        merchant_name: m.name.split(" ").slice(0, 2).join(" "),
      });
    }

    // The bill: one debit leaving the current account, one credit landing on the
    // card, same magnitude, same day. Two legs of one movement.
    if (billed > 0) {
      const paidAt = iso(inMonth(26));
      balance = round2(balance - billed);
      currentAccountTransactions.push({
        timestamp: paidAt,
        description: "SYNTHETIC REWARDS CARD PAYMENT",
        transaction_type: "DEBIT",
        transaction_category: "DIRECT_DEBIT",
        transaction_classification: [],
        amount: -billed,
        currency: "GBP",
        transaction_id: nextId(),
        provider_transaction_id: nextId(),
        running_balance: { currency: "GBP", amount: balance },
      });
      cardTransactions.push({
        timestamp: paidAt,
        description: "CARD PAYMENT THANK YOU",
        transaction_type: "CREDIT",
        transaction_category: "CREDIT",
        transaction_classification: [],
        // Inverted again: a payment REDUCES what you owe, so it is negative.
        amount: -billed,
        currency: "GBP",
        transaction_id: nextId(),
        provider_transaction_id: nextId(),
      });
      expectedTransferPairs.push({ amountMajor: billed, timestamp: paidAt });
    }

    // A standing order into savings — a second kind of internal transfer, and
    // one where both accounts are ordinary accounts rather than a card.
    const sweep = 200.0;
    balance = round2(balance - sweep);
    currentAccountTransactions.push({
      timestamp: iso(inMonth(4)),
      description: "TRANSFER TO RAINY DAY",
      transaction_type: "DEBIT",
      transaction_category: "TRANSFER",
      transaction_classification: [],
      amount: -sweep,
      currency: "GBP",
      transaction_id: nextId(),
      provider_transaction_id: nextId(),
      running_balance: { currency: "GBP", amount: balance },
    });
    savingsTransactions.push({
      timestamp: iso(inMonth(4)),
      description: "TRANSFER FROM EVERYDAY",
      transaction_type: "CREDIT",
      transaction_category: "TRANSFER",
      transaction_classification: [],
      amount: sweep,
      currency: "GBP",
      transaction_id: nextId(),
      provider_transaction_id: nextId(),
    });
    expectedTransferPairs.push({ amountMajor: sweep, timestamp: iso(inMonth(4)) });
  }

  return {
    currentAccount,
    savingsAccount,
    card,
    currentAccountTransactions,
    savingsTransactions,
    cardTransactions,
    expectedTransferPairs,
  };
}

/**
 * Pending rows, which arrive on a separate endpoint and carry no running
 * balance — the difference that made `running_balance` optional in the mapper.
 */
export function generatePending(count = 3, opts: { seed?: number; at?: string } = {}): RawTransaction[] {
  const rand = seeded(opts.seed ?? 7);
  const at = Date.parse(opts.at ?? "2026-01-01T00:00:00.000Z");
  return Array.from({ length: count }, (_, i) => {
    const m = MERCHANTS[Math.floor(rand() * MERCHANTS.length)]!;
    return {
      timestamp: iso(at - i * DAY_MS),
      description: m.name,
      transaction_type: "DEBIT" as const,
      transaction_category: m.category,
      transaction_classification: [],
      amount: -round2(m.min + rand() * (m.max - m.min)),
      currency: "GBP",
      transaction_id: `syn-pending-${i}`,
      // Pending rows have no stable provider id and no running balance.
    };
  });
}
