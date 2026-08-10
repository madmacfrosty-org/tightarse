/**
 * The categories the model is allowed to choose from.
 *
 * Fixed and closed on purpose. Free-form categories are useless for
 * aggregation — "Tesco", "Groceries", "Supermarket" and "Food shopping" would
 * all appear as separate lines in a spending breakdown, and the totals would be
 * meaningless. A closed list also makes the output verifiable: anything outside
 * it is a rejected response rather than a new category.
 *
 * Shaped for UK household spending, which is what the ledger contains.
 */
export const CATEGORIES = [
  "Groceries",
  "Eating Out",
  "Transport",
  "Fuel",
  "Utilities",
  "Council Tax",
  "Rent & Mortgage",
  "Insurance",
  "Phone & Internet",
  "Subscriptions",
  "Shopping",
  "Health",
  "Fitness",
  "Childcare",
  "Education",
  "Entertainment",
  "Travel",
  "Cash Withdrawal",
  "Fees & Charges",
  "Savings & Investments",
  "Income",
  "Gifts & Charity",
  "Home & Garden",
  "Professional Services",
  "Transfer",
  "Other",
] as const;

export type Category = (typeof CATEGORIES)[number];

const CATEGORY_SET: ReadonlySet<string> = new Set(CATEGORIES);

export function isCategory(value: string): value is Category {
  return CATEGORY_SET.has(value);
}

/**
 * "Other" is a real answer, not a failure.
 *
 * A model pushed to avoid it will invent a confident-looking wrong category,
 * which is worse than an honest admission — a misfiled transaction is harder to
 * spot than an uncategorised one.
 */
export const FALLBACK_CATEGORY: Category = "Other";
