import {
  type CategoryTotal,
  type MonthTotal,
  type Summary,
  type TransactionView,
  type AccountView,
} from "@tightarse/api-contract";
import { assertSingleCurrency } from "@tightarse/schema";
import { detectTransfers, type TransferOptions } from "./transfers.js";

/**
 * The response shapes are defined in `@tightarse/api-contract`, not here.
 *
 * They used to be interfaces in this file, and the dashboard kept its own copy
 * of each — already drifted, and a rename would have compiled clean on both
 * sides and rendered `undefined`. See #22.
 *
 * `LedgerRow` and `EnrichmentRow` stay below: they describe what comes back
 * from the ledger, which is an input to this file rather than anything promised
 * to a client.
 */
export type { CategoryTotal, MonthTotal, Summary, TransactionView, AccountView };

/**
 * Aggregation over ledger rows. Pure — no DynamoDB, no HTTP.
 *
 * Everything sums in minor units and only ever within a single currency;
 * `assertSingleCurrency` throws rather than adding yen to pounds, because a
 * plausible wrong total is worse than an error.
 */

export interface LedgerRow {
  dedupKey: string;
  timestamp: string;
  amount: number;
  currency: string;
  description: string;
  accountId: string;
  providerCategory?: string;
  transactionType: string;
}

export interface EnrichmentRow {
  dedupKey: string;
  category: string;
  confidence?: number;
}


/**
 * Category for a row: ours if the categoriser has produced one, otherwise the
 * provider's, marked provisional.
 *
 * TrueLayer supplies no classification at all for First Direct, so
 * `providerCategory` is the coarse `transaction_category` — PURCHASE,
 * DIRECT_DEBIT and so on. Useful as a shape, not as a spending category.
 */
function categoryOf(
  row: LedgerRow,
  enriched: Map<string, EnrichmentRow>,
): { category: string; provisional: boolean } {
  const e = enriched.get(row.dedupKey);
  if (e) return { category: e.category, provisional: false };
  return { category: row.providerCategory ?? "UNCATEGORISED", provisional: true };
}

export function summarise(
  transactions: readonly LedgerRow[],
  enrichments: readonly EnrichmentRow[],
  range: { from: string; to: string },
  opts: { transfers?: TransferOptions | false } = {},
): Summary {
  const currency = assertSingleCurrency(transactions);
  const enriched = new Map(enrichments.map((e) => [e.dedupKey, e]));

  // Transfers are excluded from income, spend and categories, but still counted
  // and reported — the money did move, and hiding it entirely would make
  // balances look wrong.
  const detection =
    opts.transfers === false
      ? { pairs: [], keys: new Set<string>(), totalMoved: 0 }
      : detectTransfers(transactions, opts.transfers ?? {});

  const categories = new Map<string, CategoryTotal>();
  const months = new Map<string, MonthTotal>();
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

    const { category, provisional } = categoryOf(row, enriched);
    const c = categories.get(category) ?? { category, total: 0, count: 0, provisional };
    c.total += row.amount;
    c.count += 1;
    // Once any row in a category is properly enriched the group is no longer
    // wholly provisional.
    c.provisional = c.provisional && provisional;
    categories.set(category, c);

    const month = row.timestamp.slice(0, 7);
    const m = months.get(month) ?? { month, income: 0, spend: 0, net: 0, count: 0 };
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
    byMonth: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    internalTransfersNetted: opts.transfers !== false,
    transferCount: detection.keys.size,
    transferTotal: detection.totalMoved,
    enrichedCount: transactions.filter((t) => enriched.has(t.dedupKey)).length,
  };
}

/** Transactions with their category attached, newest first. */
export function mergeEnrichments(
  transactions: readonly LedgerRow[],
  enrichments: readonly EnrichmentRow[],
): TransactionView[] {
  const enriched = new Map(enrichments.map((e) => [e.dedupKey, e]));
  return [...transactions]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .map((row) => ({ ...row, ...categoryOf(row, enriched) }));
}

/**
 * A stored account row, as the client is allowed to see it.
 *
 * `/accounts` used to return whatever DynamoDB held, so the partition key, the
 * tenant id and the provider's own account id all went to the browser. None is
 * any use to a client and all three became a promise the moment they were
 * served.
 *
 * A projection rather than `AccountView.parse`, deliberately. A strict parse
 * would throw on one malformed row and fail the whole endpoint, and an account
 * missing from the list understates the household's position — a quieter wrong
 * answer than an error. The return type is what keeps this honest: adding a
 * required field to the contract fails this function's build.
 */
export function toAccountView(row: Record<string, unknown>): AccountView {
  const str = (key: string): string | undefined =>
    typeof row[key] === "string" ? (row[key] as string) : undefined;
  const num = (key: string): number | undefined =>
    typeof row[key] === "number" ? (row[key] as number) : undefined;

  return {
    accountId: str("accountId") ?? "",
    // Absent rather than defaulted. See the contract: for isCard in particular,
    // "not yet known" and "not a card" are different answers and #29 is about
    // what a client should do with the difference.
    ...(str("displayName") !== undefined ? { displayName: str("displayName")! } : {}),
    ...(str("institutionName") !== undefined ? { institutionName: str("institutionName")! } : {}),
    ...(str("currency") !== undefined ? { currency: str("currency")! } : {}),
    ...(typeof row["isCard"] === "boolean" ? { isCard: row["isCard"] } : {}),
    ...(str("accountType") !== undefined ? { accountType: str("accountType")! } : {}),
    ...(num("currentBalance") !== undefined ? { currentBalance: num("currentBalance")! } : {}),
    ...(num("availableBalance") !== undefined ? { availableBalance: num("availableBalance")! } : {}),
    ...(str("lastSyncedAt") !== undefined ? { lastSyncedAt: str("lastSyncedAt")! } : {}),
  };
}
