/**
 * What a rule is allowed to see of a stored transaction.
 *
 * Deliberately less than a row: a rule may read what the transaction says about
 * itself and nothing else. Shared by every use case that evaluates rules, so
 * they cannot disagree about what a matcher is shown — two copies of this is how
 * a rule matches in one command and not in another.
 *
 * This used to take an untyped row and coerce every field, defaulting a missing
 * description to empty and a missing amount to zero, because a scan returned
 * whatever was stored. It no longer needs to: `listRange` returns
 * `RecordedTransaction`, so a row that is not one never gets this far. The
 * coercions were not protecting anything, they were describing a boundary that
 * had not been drawn yet (#41) — and a rule evaluated against an amount
 * defaulted to zero would match on a number the ledger never held.
 */

import type { Candidate } from "../categorisation/taxonomy.js";
import type { RecordedTransaction } from "../ledger/transaction.js";

export function candidateOf(row: RecordedTransaction): Candidate {
  return {
    dedupKey: row.dedupKey,
    description: row.description,
    amount: row.amount,
    currency: row.currency,
    ...(row.providerCategory === undefined
      ? {}
      : { providerCategory: row.providerCategory }),
  };
}
