/**
 * Books, legs and trades.
 *
 * The vocabulary [books.md](../../../../docs/design/books.md) argues for, as
 * types. This is step 1 of #108 and it deliberately changes no figure: it names
 * what the ledger has always contained, so that later steps have something to
 * say it in.
 *
 * The claim is that **every transaction already has two sides** — the account it
 * crossed, and whatever it was for — and that categorising a transaction is
 * recording the second one. Nothing new is stored to make that true. A leg is a
 * projection of rows the ports already return, which is why every position that
 * follows from it can be recomputed rather than kept, and why improving a rule
 * improves last year's figures.
 */

import type { RecordedTransaction } from "./transaction.js";
import type { Categorisation } from "../categorisation/categorisation.js";

/**
 * A named place legs accumulate.
 *
 * A bank account is a book; so is a category; so is a loan. Whether a book's id
 * and a category's id are the same string is deliberately still open — see
 * #108 — so nothing here builds a single namespace across both kinds. Until a
 * position spans them, it does not have to be decided.
 */
export type BookId = string;

/**
 * One side of one trade.
 *
 * Two dates, not one, and not three. It **applies at** the moment the money
 * moved, so improving a rule corrects March rather than posting a lump today;
 * it is **recorded at** the moment we decided it belonged there, so what March
 * said in April stays answerable. `appliesAt` is inherited from the bank's
 * transaction where there is one behind it, and chosen where there is not.
 */
export interface Leg {
  readonly book: BookId;
  /** Minor units. Negative left the book, positive arrived. */
  readonly amount: number;
  readonly appliesAt: string;
  readonly recordedAt: string;
}

/**
 * The legs that balance to zero.
 *
 * That they balance is an invariant rather than a variety: a trade that does not
 * is a defect. `isBalanced` exists to be asserted in tests rather than checked on
 * every construction, because the constructors below cannot produce an unbalanced
 * one and paying for the check on every row would buy nothing.
 */
export interface Trade {
  /** The transaction this arose from. Content-addressed, so it identifies it. */
  readonly dedupKey: string;
  readonly legs: readonly Leg[];
}

/** Whether a trade's legs sum to zero, which they must. */
export function isBalanced(trade: Trade): boolean {
  return trade.legs.reduce((sum, leg) => sum + leg.amount, 0) === 0;
}

/**
 * Money between two books the household holds.
 *
 * Named here because #108 asks for it, and because it is what the model does
 * differently: today a transfer is a pair of rows that detection finds and the
 * summary then skips. Under books it is a trade whose two legs are both assets,
 * so it never enters a spending flow to have to be taken back out. Detection
 * still does the finding — this only gives the thing it finds a name.
 */
export interface Transfer {
  readonly from: BookId;
  readonly to: BookId;
  /** Absolute, in minor units. The direction is carried by `from` and `to`. */
  readonly amount: number;
  readonly appliesAt: string;
}

/** What a transaction with no categorisation of ours is filed under. */
export const UNCATEGORISED = "UNCATEGORISED";

/**
 * The book a transaction's second leg goes to.
 *
 * Nothing is uncategorised. A transaction arrives into the book named by the
 * provider's own category — `PURCHASE`, `DIRECT_DEBIT` — and a rule moves it out
 * into one of ours, so the books balance before anybody has filed anything. The
 * fallback exists for the rows where the provider named nothing either.
 */
export function bookFor(
  transaction: RecordedTransaction,
  categorisation: Categorisation | undefined,
): BookId {
  return (
    categorisation?.category ?? transaction.providerCategory ?? UNCATEGORISED
  );
}

/**
 * The two legs one transaction gives rise to.
 *
 * The account leg keeps the transaction's own sign, which is authoritative —
 * negative left the household, positive arrived — and is not re-derived here.
 * The second leg is its negation, because the two are one movement seen from
 * both ends.
 *
 * Note what that means for a payment out: cash falls by 1299 and the Groceries
 * book **rises** by 1299. A book's position is what has accumulated in it, so an
 * expense book's position is positive. The summary reports spending as negative
 * because it reports it from the household's side of the trade, and that
 * conversion is the reporting boundary's job rather than the model's.
 */
export function tradeFor(
  transaction: RecordedTransaction,
  categorisation: Categorisation | undefined,
): Trade {
  const appliesAt = transaction.timestamp;
  return {
    dedupKey: transaction.dedupKey,
    legs: [
      {
        book: transaction.accountId,
        amount: transaction.amount,
        appliesAt,
        // When we learned of the bank's fact; the bank's own record time is
        // deliberately not a third axis. See #108.
        recordedAt: transaction.ingestedAt,
      },
      {
        book: bookFor(transaction, categorisation),
        amount: -transaction.amount,
        appliesAt,
        // When the rule ran, where a rule ran. A transaction sitting in the
        // provider's book was recorded when we ingested it.
        recordedAt: categorisation?.appliedAt ?? transaction.ingestedAt,
      },
    ],
  };
}

/** The leg that is not the bank account: the one categorising records. */
export function categoryLeg(trade: Trade): Leg {
  // Index 1 by construction. Named rather than indexed at the call sites, so
  // the ordering is stated in one place instead of assumed in several.
  return trade.legs[1]!;
}

/** The leg against the bank account the money crossed. */
export function accountLeg(trade: Trade): Leg {
  return trade.legs[0]!;
}

/**
 * Every trade a set of transactions gives rise to, given what is categorised.
 *
 * Derived, never stored. The map is the effective categorisation per transaction
 * — precedence between rule sets has already been resolved by the time anything
 * here is called, because which set wins is a question about rules rather than
 * about books.
 */
export function tradesFrom(
  transactions: readonly RecordedTransaction[],
  categorisations: ReadonlyMap<string, Categorisation>,
): Trade[] {
  return transactions.map((t) =>
    tradeFor(t, categorisations.get(t.dedupKey)),
  );
}

/**
 * A book's position on each of a series of days.
 *
 * The running sum of the book's legs, and nothing else. One rule for every
 * book: a bank account, a category, a loan. Where the position of an account
 * has until now been *observed* — carried forward from the provider's own
 * running balance — this derives it, which is #108 step 2 and the point at
 * which the ledger starts stating a figure rather than relaying one.
 *
 * Legs are placed by `appliesAt`, so a rule that recategorises March moves
 * March. `recordedAt` is deliberately not consulted here; asking what a
 * position looked like at a past moment is step 4, and answering it means
 * filtering the legs before they arrive rather than complicating this.
 *
 * `days` must be ascending. `opening` is the position before the first of them:
 * zero for a book that began empty, which is every category, and bootstrapped
 * from the provider for an account that did not.
 */
export function positionsFor(
  legs: readonly Leg[],
  days: readonly string[],
  opening = 0,
): number[] {
  if (days.length === 0) return [];

  const byDay = new Map<string, number>();
  for (const leg of legs) {
    const day = leg.appliesAt.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + leg.amount);
  }

  // Everything effective before the window is part of the position on its first
  // day, not absent from it. A window that began after a book did would
  // otherwise open at its opening figure and jump.
  const first = days[0]!;
  let running = opening;
  for (const [day, amount] of byDay) if (day < first) running += amount;

  return days.map((day) => {
    running += byDay.get(day) ?? 0;
    return running;
  });
}
