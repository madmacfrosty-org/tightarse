import type { CategoryLabel } from "./taxonomy.js";
import { merchantCategories, merchantPatternFor } from "./merchants.js";

/**
 * Deterministic merchant rules, applied before any model call.
 *
 * Two things this buys that a model cannot:
 *
 *   - Stability. Your everyday merchants get the same category for ever,
 *     rather than shifting when a model version changes underneath you.
 *   - Privacy. A matched transaction's description never leaves the account.
 *
 * It is NOT a cost measure. A full 9,653-transaction run costs about 80p, so
 * halving the token count saves pennies. Anyone maintaining this should weigh
 * new rules on determinism and data egress, not on spend.
 *
 * The merchant patterns are no longer written here. They are DERIVED from
 * `merchants.ts`, which is also what generated test data draws its descriptions
 * from — so a generated transaction is matched by a generated rule by
 * construction, rather than by two lists being kept in step by hand. What
 * remains below is the residue that a merchant list cannot express, because it
 * matches on wording rather than on a merchant.
 */

/**
 * A compiled merchant rule: a description pattern and the category it implies.
 *
 * Distinct from `Rule` in ./rules.ts, which is #39's authored, versioned model
 * and is meant to replace this. Both exist while that changeover is unbuilt, and
 * they were both called `Rule` in different packages — which only worked because
 * nothing imported the two together.
 */
export interface MerchantRule {
  readonly pattern: RegExp;
  readonly category: CategoryLabel;
}

/**
 * The patterns a new household starts with.
 *
 * A SEED, not a source. Once `seed-cli` has run, `built-in` lives in the table
 * as a versioned set and is changed there — by proposal, measured against the
 * real ledger, and accepted. Editing this list afterwards changes what the NEXT
 * household starts with and nothing else.
 *
 * That is deliberate. Rules are data: narrowing a pattern that matched motorway
 * services when it meant fuel should not need a pull request and a deploy, and
 * once a change is versioned, dry-run, breadth-measured and diffed before and
 * after, the gate is the review.
 *
 * The risk is drift — someone "fixing" a pattern here that the table stopped
 * using months ago — which is why this says so rather than leaving it to be
 * discovered.
 */
export const RULES: readonly MerchantRule[] = [
  // Derived: one pattern per category, over every merchant in that category.
  ...merchantCategories().map((category) => ({
    pattern: new RegExp(merchantPatternFor(category), "i"),
    category,
  })),

  // Not derivable from a merchant list. These match on WORDING, because there
  // is no merchant involved — a bank charge is described by what it is, and a
  // card being paid off is money moving between your own accounts rather than
  // spending. Left as written until something better absorbs them.
  { pattern: /\bCOUNCIL\b.*\bTAX\b|\bCOUNCIL TAX\b/i, category: "Council Tax" },
  {
    pattern: /\bNON[- ]STERLING (TRANSACTION )?FEE\b/i,
    category: "Fees & Charges",
  },
  {
    pattern: /\b(OVERDRAFT|UNARRANGED) (FEE|INTEREST|CHARGE)\b/i,
    category: "Fees & Charges",
  },
  // Named issuers only — a rule broad enough to catch "CARD PAYMENT" would
  // swallow ordinary purchases.
  { pattern: /\b(AMERICAN EXPRESS|AMEX)\b/i, category: "Transfer" },
  { pattern: /\bPAYMENT RECEIVED\b.*\bTHANK YOU\b/i, category: "Transfer" },
];

/**
 * Cash and bank charges are identified by the provider's own transaction type
 * rather than the description, which is far more reliable — an ATM withdrawal's
 * description is usually a location, not a merchant.
 */
export const PROVIDER_RULES: Readonly<Record<string, CategoryLabel>> = {
  ATM: "Cash Withdrawal",
};
