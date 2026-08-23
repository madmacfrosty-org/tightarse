/**
 * The category labels in use.
 *
 * Fixed and closed on purpose. Free-form categories are useless for
 * aggregation — "Tesco", "Groceries", "Supermarket" and "Food shopping" would
 * all appear as separate lines in a spending breakdown, and the totals would be
 * meaningless.
 *
 * These are LABELS, not identities. `./category.ts` holds the entity, and
 * `SEED_CATEGORIES` derives one per label so that renaming a label stops being
 * a migration across every stored row. This list stays because the rules still
 * in service name categories by label; it goes when they name ids instead.
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

export type CategoryLabel = (typeof CATEGORIES)[number];

/**
 * "Other" is a real answer, not a failure.
 *
 * Where no rule places a transaction, saying so plainly beats stretching a rule
 * to cover it: a misfiled transaction is far harder to spot than an
 * uncategorised one.
 */
export const FALLBACK_CATEGORY: CategoryLabel = "Other";

/**
 * A transaction awaiting a category.
 *
 * What a matcher is given to decide on. Deliberately less than a ledger row:
 * a rule may see what the transaction says about itself, and nothing else.
 */
export interface Candidate {
  dedupKey: string;
  description: string;
  /** Signed minor units. */
  amount: number;
  currency: string;
  /** TrueLayer's coarse `transaction_category`: PURCHASE, DIRECT_DEBIT, ATM… */
  providerCategory?: string;
}

/**
 * A category applied to one candidate by the rules.
 *
 * No confidence. A rule either matched or it did not, and every rule path set
 * the number to 1 — a field carrying one value carries no information, and the
 * command line was sorting "lowest confidence first, where errors hide" over a
 * constant. It was meaningful when a model returned one; it has not been since.
 */
export interface Classification {
  dedupKey: string;
  category: CategoryLabel;
}
