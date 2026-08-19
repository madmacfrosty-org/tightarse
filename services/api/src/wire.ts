/**
 * Where a domain answer becomes an HTTP response.
 *
 * `@tightarse/ports` says what the application offers; `@tightarse/api-contract`
 * says what installed clients were promised. Those change for different reasons —
 * a browser reloads, an iOS build on somebody's phone does not — so they are two
 * statements, and this is the one place they meet.
 *
 * They are near-identities, and each is annotated on both sides, so if the domain
 * result and the wire promise ever stop agreeing this file fails to compile and
 * someone decides what the API should do about it. Previously the use cases had no
 * declared return type at all, so whatever the aggregation happened to produce was
 * served, and the contract was a document the code was merely expected to match.
 *
 * The copies are not ceremony. The domain returns `readonly` arrays — a result is
 * not the caller's to mutate — while the contract's types are inferred from Zod
 * and are mutable, so the conversion is real and the compiler already insisted on
 * it. Copying also means nothing downstream can reach back into the aggregation's
 * own arrays.
 *
 * When they diverge further — the first field the domain needs that clients must
 * not see, or the first rename the contract cannot afford — it happens here and
 * nothing else moves.
 */

import type {
  AccountsResponse,
  BalancesResponse,
  SummaryResponse,
  TransactionsResponse,
} from "@tightarse/api-contract";
import type { AccountsResult, BalancesResult, Summary, TransactionsResult } from "@tightarse/ports";

export const asSummary = (s: Summary): SummaryResponse => ({
  ...s,
  byCategory: [...s.byCategory],
  byMonth: [...s.byMonth],
});

export const asTransactions = (t: TransactionsResult): TransactionsResponse => ({
  range: t.range,
  transactions: [...t.transactions],
});

export const asAccounts = (a: AccountsResult): AccountsResponse => ({
  ...a,
  accounts: [...a.accounts],
});

export const asBalances = (b: BalancesResult): BalancesResponse => ({
  range: b.range,
  points: [...b.points],
});
