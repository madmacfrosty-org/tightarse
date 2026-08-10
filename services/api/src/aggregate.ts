import { assertSingleCurrency } from "@tightarse/schema";
import { detectTransfers, type TransferOptions } from "./transfers.js";

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

export interface CategoryTotal {
  category: string;
  /** Negative for spending, positive for income. */
  total: number;
  count: number;
  /** True when this came from the provider rather than our categoriser. */
  provisional: boolean;
}

export interface MonthTotal {
  month: string;
  income: number;
  spend: number;
  net: number;
  count: number;
}

export interface Summary {
  currency: string | null;
  from: string;
  to: string;
  transactionCount: number;
  income: number;
  spend: number;
  net: number;
  byCategory: CategoryTotal[];
  byMonth: MonthTotal[];
  /**
   * Whether movement between the household's own accounts has been removed from
   * income and spend. Reported rather than assumed, so a caller can never
   * mistake an inflated total for a real one.
   */
  internalTransfersNetted: boolean;
  /** How many transactions were identified as legs of an internal transfer. */
  transferCount: number;
  /** Absolute value moved between own accounts, in minor units. Excluded from
   *  income and spend, but reported so the movement is visible rather than
   *  simply missing. */
  transferTotal: number;
  /** How many rows carry a category from our own categoriser rather than the
   *  provider. Zero until the categoriser runs. */
  enrichedCount: number;
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

    // Sign is authoritative: debits negative, credits positive, consistent
    // across every transaction measured.
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
): Array<LedgerRow & { category: string; provisional: boolean }> {
  const enriched = new Map(enrichments.map((e) => [e.dedupKey, e]));
  return [...transactions]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .map((row) => ({ ...row, ...categoryOf(row, enriched) }));
}
