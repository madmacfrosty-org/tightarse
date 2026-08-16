/**
 * What the API promises its clients.
 *
 * Separate from `@tightarse/schema`, which is what is in the table. The two look
 * alike and are not: changing a stored shape is a migration under our own
 * control, whereas changing a shape on the wire is a promise to something
 * already installed. A browser reloads; an iOS build on somebody's phone does
 * not, so a rename here can strand a client that a table migration never could.
 *
 * Zod rather than interfaces, so one definition can produce the TypeScript the
 * dashboard imports and the OpenAPI a Swift client is generated from. See #22
 * for the reasoning and #26 for the generation.
 */
import { z } from "zod";

/**
 * Money, in integer minor units.
 *
 * A function rather than a constant so the description names the field, and so
 * that no monetary field can be declared without saying what its number means.
 * `money()` in the dashboard divides by 100; a client that reads these as
 * decimal pounds is wrong by a factor of 100 on every screen.
 *
 * This repository has already lost five years of ledger to an arithmetic
 * convention that everyone knew and nobody wrote down, which is why the unit
 * travels in the contract rather than in a comment beside it.
 */
const minorUnits = (what: string) =>
  z
    .number()
    .int()
    .describe(`${what}, in integer minor units (pence). Divide by 100 for pounds.`);

/**
 * A date, `YYYY-MM-DD`, in no particular timezone.
 *
 * Ranges are inclusive at both ends: `from=2026-05-01&to=2026-05-01` is one day
 * and returns that day's transactions.
 */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Date as YYYY-MM-DD");

export const DateRange = z.object({
  from: IsoDate,
  to: IsoDate,
});
export type DateRange = z.infer<typeof DateRange>;

/**
 * Whether a category came from our categoriser or from the provider.
 *
 * The dashboard greys the provider's, because a bank's payment type is not a
 * spending category and presenting one as the other overstates how much of the
 * ledger is actually categorised.
 */
export const Provisional = z
  .boolean()
  .describe("True when this is the provider's own payment type, not a category we produced");

export const CategoryTotal = z.object({
  category: z.string(),
  total: minorUnits("Total for this category, negative for spending and positive for income"),
  count: z.number().int().describe("How many transactions contributed"),
  provisional: Provisional,
});
export type CategoryTotal = z.infer<typeof CategoryTotal>;

export const MonthTotal = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/).describe("Month as YYYY-MM"),
  income: minorUnits("Money that arrived this month"),
  spend: minorUnits("Money that left this month, negative"),
  net: minorUnits("income + spend for the month"),
  count: z.number().int().describe("How many transactions contributed"),
});
export type MonthTotal = z.infer<typeof MonthTotal>;

export const Summary = z.object({
  /**
   * Null when the range holds no transactions — a real value meaning "nothing
   * to report a currency for", not a missing field.
   */
  currency: z.string().nullable(),
  from: IsoDate,
  to: IsoDate,
  transactionCount: z.number().int(),
  income: minorUnits("Money that arrived across the range"),
  spend: minorUnits("Money that left across the range, negative"),
  net: minorUnits("income + spend across the range"),
  byCategory: z.array(CategoryTotal),
  byMonth: z.array(MonthTotal),
  /**
   * Whether movement between the household's own accounts has been removed from
   * income and spend. Reported rather than assumed, so a caller can never
   * mistake an inflated total for a real one.
   */
  internalTransfersNetted: z.boolean(),
  transferCount: z.number().int(),
  transferTotal: minorUnits("Total moved between the household's own accounts"),
  enrichedCount: z.number().int().describe("How many transactions carry a category"),
});
export type Summary = z.infer<typeof Summary>;

/**
 * A transaction as a client sees it: the ledger row with its category attached.
 *
 * One sign convention throughout: negative left the household, positive
 * arrived. The provider does not supply this — it reports cards from the
 * issuer's point of view — so ingest normalises at the boundary and everything
 * downstream, including this, relies on it. Do not re-derive direction from
 * `transactionType`.
 */
export const TransactionView = z.object({
  dedupKey: z.string(),
  timestamp: z.string().describe("ISO 8601 instant"),
  amount: minorUnits("Negative left the household, positive arrived"),
  currency: z.string(),
  description: z.string(),
  accountId: z.string(),
  transactionType: z.string().describe("The provider's own type. Not the direction — see amount"),
  providerCategory: z.string().optional(),
  category: z.string(),
  provisional: Provisional,
});
export type TransactionView = z.infer<typeof TransactionView>;

/**
 * An account as a client sees it.
 *
 * Deliberately not the stored row. The ledger's own account items carry table
 * keys, the tenant id and the provider's account id, none of which a client has
 * any use for, and all of which become a promise the moment they are served.
 *
 * `currentBalance` is what the provider reports, unchanged. For a card that is
 * what is OWED, expressed positive — `isCard` is what tells a client to present
 * it as a debt. It is recorded from the endpoint the data came from and never
 * inferred from the balances: "available exceeds current" is true of a credit
 * card with headroom and false of Amex, which reports no available balance at
 * all, and that guess once showed a £567.90 debt as money in hand.
 */
export const AccountView = z.object({
  accountId: z.string(),
  /**
   * These four are optional because a row can exist without them.
   *
   * Balances arrive on their own endpoint and may land before account details,
   * and `putBalances` creates the row when it does — deliberately, because the
   * previous approach wrote a whole placeholder account and its "unknown"
   * institution then overwrote real details fetched moments earlier.
   *
   * So an account can legitimately be seen mid-sync with a balance and no
   * identity. Marking these required would make the contract a lie and a strict
   * parse would fail the whole endpoint for one half-written row.
   */
  displayName: z.string().optional(),
  institutionName: z.string().optional(),
  currency: z.string().optional(),
  /**
   * Absent means NOT YET KNOWN, not "no".
   *
   * Whether a balance is money held or money owed. Treating absent as `false`
   * puts a card's balance into the cash total and then subtracts nothing,
   * overstating the household's position by twice the debt — which is the shape
   * of the £567.90 bug, arrived at from a different direction. A client should
   * say it does not know rather than guess. See #29.
   *
   * It stays optional even though both write paths now set it — the balance
   * path derives it from which endpoint returned the data, so a row created
   * balance-first carries it too. Optional describes what a client may receive,
   * not what is written today: making it required would fail the whole endpoint
   * for a single unclassifiable row, which is a bad trade when the alternative
   * is one account rendering as "syncing".
   */
  isCard: z.boolean().optional(),
  accountType: z.string().optional(),
  /** Absent when the balance has never been fetched, which is not the same as zero. */
  currentBalance: minorUnits("Balance as the provider reports it; for a card, what is owed").optional(),
  availableBalance: minorUnits("Funds available to spend").optional(),
  lastSyncedAt: z.string().optional().describe("ISO 8601 instant of the last successful fetch"),
});
export type AccountView = z.infer<typeof AccountView>;

// ------------------------------------------------------------------ responses

export const SummaryResponse = Summary;
export type SummaryResponse = z.infer<typeof SummaryResponse>;

export const TransactionsResponse = z.object({
  range: DateRange,
  transactions: z.array(TransactionView),
});
export type TransactionsResponse = z.infer<typeof TransactionsResponse>;

export const AccountsResponse = z.object({
  accounts: z.array(AccountView),
});
export type AccountsResponse = z.infer<typeof AccountsResponse>;

// The paths, the version and the compatibility promise (#26, #27).
//
// Named explicitly rather than `export *`. This package builds to CommonJS, and
// a star re-export compiles to `__exportStar`, which rollup cannot analyse
// statically — the dashboard's bundle then fails with "pathFor is not exported"
// even though the types resolve and every test passes. Named re-exports compile
// to property getters, which it can see.
export {
  API_VERSION,
  COMPATIBILITY_PROMISE,
  CONNECT_PATHS,
  ROUTES,
  pathFor,
  type QueryParam,
  type Route,
} from "./routes.js";
