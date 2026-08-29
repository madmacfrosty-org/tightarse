/**
 * A stored transaction, built for tests.
 *
 * The reads used to be typed `Record<string, unknown>`, so every test here
 * declared its own eight-field subset and cast it into place. The subsets had
 * drifted from each other and from the row the adapter actually returns, which
 * is the whole complaint in #41: nothing could tell you the shape was wrong.
 *
 * The defaults are invented. This repository is public and the ledger is a real
 * household's — no description, merchant or amount here corresponds to anything.
 */

import { RecordedTransaction } from "../src/ledger/transaction.js";
import { Categorisation } from "../src/categorisation/categorisation.js";

/**
 * Overrides for a test-data builder.
 *
 * `Partial<T>` cannot express "remove this field" under
 * exactOptionalPropertyTypes, and a blanket `| undefined` would let a REQUIRED
 * field be blanked, which is a different bug. Undefined is allowed only where
 * the property is already optional.
 */
export type Overrides<T> = {
  [K in keyof T]?: undefined extends T[K] ? T[K] | undefined : T[K];
};

/**
 * Build one, parsing it as production does.
 *
 * Parsed rather than cast: a builder that casts can produce a row the schema
 * would reject, and then the tests agree with each other about something the
 * adapter would never return.
 */
export function recorded(
  over: Overrides<RecordedTransaction> = {},
): RecordedTransaction {
  return RecordedTransaction.parse({
    tenantId: "t1",
    accountId: "acc1",
    transactionId: "txn-1",
    dedupKey: "n:1",
    timestamp: "2026-03-15T00:00:00Z",
    amount: -1299,
    currency: "GBP",
    description: "SHOP",
    status: "settled",
    transactionType: "DEBIT",
    providerCategory: "PURCHASE",
    ingestedAt: "2026-03-16T00:00:00Z",
    ...over,
  });
}

/**
 * A stored categorisation.
 *
 * The reporting path used to take a three-field projection of this — dedup key,
 * category, set — declared locally. The extra fields are not decoration: the
 * version and status are what `resolve` ranks on, so a test built from the
 * projection could not express the case where two sets disagree.
 */
export function assigned(
  dedupKey: string,
  category: string,
  over: Overrides<Categorisation> = {},
): Categorisation {
  return Categorisation.parse({
    dedupKey,
    category,
    setId: "built-in",
    setVersion: 1,
    version: 1,
    status: "effective",
    timestamp: "2026-03-15T00:00:00Z",
    appliedAt: "2026-03-16T00:00:00Z",
    ...over,
  });
}
