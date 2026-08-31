import type {
  AccountState,
  CategorisedTransaction,
  CategoryTotal,
  MonthTotal,
  Summary,
} from "../index.js";
import { PROVIDER_SET } from "../categorisation/provider.js";
import type { Categorisation } from "../categorisation/categorisation.js";
import type { RecordedTransaction } from "../ledger/transaction.js";
import { bookFor, categoryLeg, tradeFor } from "../ledger/books.js";
import { assertSingleCurrency } from "../index.js";
import { detectTransfers, type TransferOptions } from "./transfers.js";

/**
 * The result shapes come from `@tightarse/domain`, not from here and not from the
 * wire contract.
 *
 * They were interfaces in this file once, and the dashboard kept its own copy of
 * each — already drifted, and a rename would have compiled clean on both sides
 * and rendered `undefined` (#22). They then moved to `@tightarse/api-contract`,
 * which fixed the drift and put a promise made to installed clients in the middle
 * of the application's own vocabulary. They are domain shapes; how they are spelled
 * on the wire is `wire.ts`'s problem.
 *
 * The ledger's own shapes are not redeclared here either. `RecordedTransaction`
 * and `Categorisation` come from the domain that defines them, so a field
 * renamed there fails here rather than quietly reading as undefined (#41).
 */
// No re-export: these are declared in ports/inbound and reach consumers through
// the package index. Passing them through here was for the API's convenience when
// this file lived in that service, and inside one package it is a second export
// of the same name.

/**
 * Aggregation over ledger rows. Pure — no DynamoDB, no HTTP.
 *
 * Everything sums in minor units and only ever within a single currency;
 * `assertSingleCurrency` throws rather than adding yen to pounds, because a
 * plausible wrong total is worse than an error.
 */

/** Mutable while accumulating. See `summarise`. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Category for a row: what a rule set assigned, or the provider's own value.
 *
 * TrueLayer supplies no classification at all for First Direct, so
 * `providerCategory` is the coarse `transaction_category` — PURCHASE,
 * DIRECT_DEBIT and so on. Useful as a shape, not as a spending category, which
 * is why it names its own set rather than passing as one of ours.
 */
function categoryOf(
  row: RecordedTransaction,
  assigned: Map<string, Categorisation>,
): { category: string; setId: string } {
  const a = assigned.get(row.dedupKey);
  // `bookFor` decides the category, so the fallback to the provider's own value
  // is stated once rather than here and in the books model separately.
  return { category: bookFor(row, a), setId: a?.setId ?? PROVIDER_SET };
}

export function summarise(
  transactions: readonly RecordedTransaction[],
  categorised: readonly Categorisation[],
  range: { from: string; to: string },
  opts: { transfers?: TransferOptions | false } = {},
): Summary {
  const currency = assertSingleCurrency(transactions);
  const assigned = new Map(categorised.map((a) => [a.dedupKey, a]));

  // Transfers are excluded from income, spend and categories, but still counted
  // and reported — the money did move, and hiding it entirely would make
  // balances look wrong.
  const detection =
    opts.transfers === false
      ? { pairs: [], keys: new Set<string>(), totalMoved: 0 }
      : detectTransfers(transactions, opts.transfers ?? {});

  // Mutable while accumulating; the port's result types are readonly, which is a
  // statement about what a caller may do with an answer rather than about how it
  // is built. `-readonly` keeps the two from being separate declarations that can
  // drift.
  const categories = new Map<string, Mutable<CategoryTotal>>();
  const months = new Map<string, Mutable<MonthTotal>>();
  let income = 0;
  let spend = 0;

  for (const row of transactions) {
    if (detection.keys.has(row.dedupKey)) continue;

    // Sign is authoritative: negative left the household, positive arrived.
    // That invariant is not free — the provider reports cards inverted, and
    // this comment asserted the property for months while card rows violated
    // it. It holds because mapTransaction now takes the sign from
    // transaction_type at the boundary. Nothing here should re-derive it.
    if (row.amount >= 0) income += row.amount;
    else spend += row.amount;

    // The transaction's two sides, named. The second leg is what categorising
    // records, and grouping by the book it lands in is what `byCategory` has
    // always been — see #108, of which this is step 1.
    const leg = categoryLeg(tradeFor(row, assigned.get(row.dedupKey)));
    const category = leg.book;
    const { setId } = categoryOf(row, assigned);
    const fromProvider = setId === PROVIDER_SET;
    const c = categories.get(category) ?? {
      category,
      total: 0,
      count: 0,
      provisional: fromProvider,
    };
    // Negated: the Groceries book *rises* by what leaves the current account, so
    // its position is positive. The summary reports spending from the
    // household's side of the trade, which is the reporting boundary's job and
    // not the model's. Same number as before, arrived at through the leg.
    c.total += -leg.amount;
    c.count += 1;
    // Still a boolean on the aggregate, because "which set" is not single-valued
    // across a group. It now means every row here came from the provider's own
    // value, rather than being a guess about whether anything categorised it.
    c.provisional = c.provisional && fromProvider;
    categories.set(category, c);

    const month = row.timestamp.slice(0, 7);
    const m = months.get(month) ?? {
      month,
      income: 0,
      spend: 0,
      net: 0,
      count: 0,
    };
    if (row.amount >= 0) m.income += row.amount;
    else m.spend += row.amount;
    m.net += row.amount;
    m.count += 1;
    months.set(month, m);
  }

  return {
    currency,
    from: range.from,
    to: range.to,
    transactionCount: transactions.length,
    income,
    spend,
    net: income + spend,
    // Largest spend first: negative totals ascending.
    byCategory: [...categories.values()].sort((a, b) => a.total - b.total),
    byMonth: [...months.values()].sort((a, b) =>
      a.month.localeCompare(b.month),
    ),
    internalTransfersNetted: opts.transfers !== false,
    transferCount: detection.keys.size,
    transferTotal: detection.totalMoved,
    enrichedCount: transactions.filter((t) => assigned.has(t.dedupKey)).length,
  };
}

/**
 * Transactions with their category attached, newest first.
 *
 * A projection, not a spread. This used to end `{ ...row, ...categoryOf(row) }`,
 * which put every attribute the row happened to carry into the response — the
 * table's partition and sort keys, both GSI keys, `kind`, the tenant id, the
 * provider's transaction ids and the raw object's S3 key. The return type did
 * not stop it: TypeScript checks excess properties on an object literal, not on
 * a spread, so `CategorisedTransaction` naming ten fields constrained nothing at
 * run time and `wire.ts` copies the array rather than projecting it.
 *
 * `AccountView` already says why this matters — the stored row's keys and ids
 * are "none of which a client has any use for, and all of which become a promise
 * the moment they are served". `/accounts` got `toAccountState`; `/transactions`
 * never got the equivalent. Naming the fields is what makes the contract and the
 * response the same thing.
 */
export function mergeCategories(
  transactions: readonly RecordedTransaction[],
  categorised: readonly Categorisation[],
): CategorisedTransaction[] {
  const assigned = new Map(categorised.map((a) => [a.dedupKey, a]));
  return [...transactions]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .map((row) => ({
      dedupKey: row.dedupKey,
      timestamp: row.timestamp,
      amount: row.amount,
      currency: row.currency,
      description: row.description,
      accountId: row.accountId,
      transactionType: row.transactionType,
      ...(row.providerCategory === undefined
        ? {}
        : { providerCategory: row.providerCategory }),
      ...categoryOf(row, assigned),
    }));
}

/**
 * A stored account row, as the client is allowed to see it.
 *
 * `/accounts` used to return whatever DynamoDB held, so the partition key, the
 * tenant id and the provider's own account id all went to the browser. None is
 * any use to a client and all three became a promise the moment they were
 * served.
 *
 * A projection rather than `AccountState.parse`, deliberately. A strict parse
 * would throw on one malformed row and fail the whole endpoint, and an account
 * missing from the list understates the household's position — a quieter wrong
 * answer than an error. The return type is what keeps this honest: adding a
 * required field to the contract fails this function's build.
 */
export function toAccountState(row: Record<string, unknown>): AccountState {
  const str = (key: string): string | undefined =>
    typeof row[key] === "string" ? (row[key] as string) : undefined;
  const num = (key: string): number | undefined =>
    typeof row[key] === "number" ? (row[key] as number) : undefined;

  return {
    accountId: str("accountId") ?? "",
    // Absent rather than defaulted. See the contract: for isCard in particular,
    // "not yet known" and "not a card" are different answers and #29 is about
    // what a client should do with the difference.
    ...(str("displayName") !== undefined
      ? { displayName: str("displayName")! }
      : {}),
    ...(str("institutionName") !== undefined
      ? { institutionName: str("institutionName")! }
      : {}),
    ...(str("currency") !== undefined ? { currency: str("currency")! } : {}),
    ...(typeof row["isCard"] === "boolean" ? { isCard: row["isCard"] } : {}),
    ...(str("accountType") !== undefined
      ? { accountType: str("accountType")! }
      : {}),
    ...(num("currentBalance") !== undefined
      ? { currentBalance: num("currentBalance")! }
      : {}),
    ...(num("availableBalance") !== undefined
      ? { availableBalance: num("availableBalance")! }
      : {}),
    ...(str("lastSyncedAt") !== undefined
      ? { lastSyncedAt: str("lastSyncedAt")! }
      : {}),
  };
}
