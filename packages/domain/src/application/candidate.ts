/**
 * What a rule is allowed to see of a stored transaction.
 *
 * Deliberately less than a row: a rule may read what the transaction says about
 * itself and nothing else. Shared by every use case that evaluates rules, so
 * they cannot disagree about what a matcher is shown — two copies of this is how
 * a rule matches in one command and not in another.
 *
 * Missing fields become empty rather than throwing. A scan returns whatever is
 * stored, and one malformed row is not a reason to abandon re-applying a ledger;
 * it simply matches nothing.
 */

import type { Candidate } from "../categorisation/taxonomy.js";
import type { Row } from "../ports/outbound/index.js";

export function candidateOf(row: Row): Candidate {
  const providerCategory = row["providerCategory"];
  return {
    dedupKey: String(row["dedupKey"] ?? ""),
    description: String(row["description"] ?? ""),
    amount: Number(row["amount"] ?? 0),
    currency: String(row["currency"] ?? "GBP"),
    // Only when it is genuinely a string: passing a number through as though it
    // were a category would make the candidate lie about its own shape.
    ...(typeof providerCategory === "string" ? { providerCategory } : {}),
  };
}
