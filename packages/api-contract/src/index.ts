/**
 * What the API promises its clients.
 *
 * Separate from `@tightarse/domain`, which is what is in the table. The two look
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
  setId: z
    .string()
    .describe("Which rule set produced the category; `provider` where nothing did"),
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
  /** Earliest date this account has any data for. Absent when it has none. */
  historyFrom: IsoDate.optional().describe("Earliest date this account has data for"),
  /**
   * Whether anything is missing before `historyFrom`.
   *
   * True means the account was opened within the data we hold, so its absence
   * from any earlier total is correct. False means it demonstrably existed
   * earlier — the balance before its first transaction was not zero — and a
   * total drawn before `historyFrom` is short by whatever it held. For a card
   * that means missing debt, so the total reads high. See #33.
   */
  historyComplete: z
    .boolean()
    .optional()
    .describe("False when the account existed before the earliest data we hold"),
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

export const BalancePoint = z.object({
  date: IsoDate,
  net: minorUnits("Cash less card debt, across every account with data that day"),
});
export type BalancePoint = z.infer<typeof BalancePoint>;

export const BalancesResponse = z.object({
  /**
   * The range actually served, which may be narrower than the one requested.
   *
   * Nothing incomplete is ever returned, so a request reaching back further
   * than `completeFrom` is clamped rather than answered with a total missing an
   * account. Compare this against what was sent to detect it.
   */
  range: DateRange,
  /** One per day across `range`, both ends inclusive. */
  points: z.array(BalancePoint),
});
export type BalancesResponse = z.infer<typeof BalancesResponse>;

export const AccountsResponse = z.object({
  accounts: z.array(AccountView),
  /**
   * The earliest date from which a household total is trustworthy.
   *
   * Computed here rather than left to clients. The rule is "the latest start
   * among accounts that are incomplete", and an account opened inside the range
   * must be excluded — a client doing the obvious `max(historyFrom)` gets it
   * wrong the first time a new account is opened, and every client would have
   * to reimplement it.
   *
   * Absent when nothing constrains the range. It moves earlier over time on its
   * own: every fetch is kept, so an account's start date is fixed once, and the
   * window widens by a day each day regardless of what the provider will serve
   * later.
   */
  completeFrom: IsoDate.optional().describe(
    "Earliest date a household total is complete; absent when unconstrained",
  ),
});
export type AccountsResponse = z.infer<typeof AccountsResponse>;

// ------------------------------------------------------------- categorisation

/**
 * What the rules do not yet cover.
 *
 * Descriptions are household data, so this is served only to an authorised
 * caller and is deliberately absent from the browser-facing document: these
 * routes are signed with SigV4, not a bearer token. See `CATEGORISATION_ROUTES`.
 */
export const CategoryTallyView = z.object({
  category: z.string().describe("The category identifier the rules produce"),
  transactions: z.number().int().nonnegative(),
});
export type CategoryTallyView = z.infer<typeof CategoryTallyView>;

export const DescriptionView = z.object({
  description: z.string(),
  transactions: z.number().int().nonnegative(),
  outgoing: minorUnits("Money that left the household under this description"),
  firstSeen: z.string().describe("Booking timestamp of the earliest sighting, ISO-8601"),
  lastSeen: z.string().describe("Booking timestamp of the latest sighting, ISO-8601"),
  uncategorised: z.number().int().nonnegative().describe("Sightings the rules currently give no category"),
  categories: z
    .array(CategoryTallyView)
    .describe("What the rules make of it now. More than one entry means it is categorised inconsistently."),
});
export type DescriptionView = z.infer<typeof DescriptionView>;

export const Cadence = z
  .enum(["weekly", "fortnightly", "four-weekly", "monthly", "quarterly", "annual"])
  .describe("The beat a repeated amount keeps");
export type Cadence = z.infer<typeof Cadence>;

export const RecurrenceView = z.object({
  amount: minorUnits("The repeated amount, signed so a recurring credit stays distinguishable"),
  cadence: Cadence,
  transactions: z.number().int().nonnegative(),
  outgoing: minorUnits("Money that left the household across the whole series"),
  descriptions: z
    .array(z.string())
    .describe("Every description this amount arrived under. More than one is the case this exists for."),
  firstSeen: z.string(),
  lastSeen: z.string(),
  uncategorised: z.number().int().nonnegative(),
});
export type RecurrenceView = z.infer<typeof RecurrenceView>;

export const GapView = z.object({
  description: z.string(),
  transactions: z.number().int().nonnegative(),
  outgoing: minorUnits("Money that left the household under it"),
});
export type GapView = z.infer<typeof GapView>;

export const ConflictView = z.object({
  setId: z.string().describe("The rule set that cannot choose"),
  categories: z.array(z.string()).describe("The categories it claims at once"),
  rules: z
    .array(z.number().int().nonnegative())
    .describe("Positions within the set that asserted them, which is how the fold identifies a rule"),
  transactions: z.number().int().nonnegative(),
  example: z
    .string()
    .describe("One description it happens on, for a human deciding which rule is wrong"),
});
export type ConflictView = z.infer<typeof ConflictView>;

export const BacklogResponse = z.object({
  range: DateRange,
  descriptions: z.array(DescriptionView).describe("Every distinct description, costliest first"),
  recurrences: z.array(RecurrenceView).describe("Amounts arriving on a beat, costliest first"),
  gaps: z.array(GapView).describe("What nothing matched, costliest first"),
  conflicts: z
    .array(ConflictView)
    .describe(
      "Where a set claims two answers at once, widest first. A conflict is a gap with a cause: " +
        "the set produces nothing, so its transactions appear in `gaps` as though no rule had been " +
        "written for them.",
    ),
  scanned: z.number().int().nonnegative(),
});
export type BacklogResponse = z.infer<typeof BacklogResponse>;

// ------------------------------------------------------------------ proposals

/**
 * A rule as the wire spells it.
 *
 * Mirrors the domain's rule rather than importing it: the domain is free to
 * change with the application's needs, and this is a promise to whatever is
 * already calling. They are near-identities today and the translation is the
 * one place that stays true when they stop being.
 */
export const MatcherView = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("merchant"), pattern: z.string().min(1).describe("Case-insensitive regular expression matched against the description") }),
  z.object({ kind: z.literal("providerCategory"), value: z.string().min(1).describe("The bank's own coarse category, e.g. DIRECT_DEBIT") }),
  z.object({ kind: z.literal("transaction"), dedupKey: z.string().min(1).describe("One transaction, by its dedup key") }),
]);
export type MatcherView = z.infer<typeof MatcherView>;

export const ContributionView = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("assert"), category: z.string().min(1).describe("Establishes a category where none was established") }),
  z.object({ kind: z.literal("refine"), category: z.string().min(1).describe("Changes a category already established in the same set. Inert if nothing was.") }),
]);
export type ContributionView = z.infer<typeof ContributionView>;

export const RuleView = z.object({
  matcher: MatcherView,
  contributes: ContributionView,
  appliesTo: z
    .enum(["debits", "credits", "all"])
    .describe("Direction this rule applies to. Credits are excluded unless a rule says otherwise."),
  note: z.string().optional(),
});
export type RuleView = z.infer<typeof RuleView>;

export const ProposedRuleSetView = z.object({
  setId: z.string().min(1),
  version: z.number().int().nonnegative().describe("The version being proposed, which must be higher than the current one"),
  name: z.string().min(1),
  order: z.number().int().describe("Precedence. Lower wins: overrides -1, household 0, built-in 2, provider 3."),
  authored: z.boolean().describe("Whether a human wrote it. Gates automatic approval only, never whether it may be proposed."),
  rules: z.array(RuleView),
});
export type ProposedRuleSetView = z.infer<typeof ProposedRuleSetView>;

export const ProposalRequest = z.object({
  sets: z
    .array(ProposedRuleSetView)
    .min(1)
    .describe("The rule sets as they would be. Sets left out are unchanged."),
  because: z.string().optional().describe("Why this is being proposed, carried onto the stored version"),
});
export type ProposalRequest = z.infer<typeof ProposalRequest>;

/** One transaction whose answer the proposal changes. */
export const ChangeView = z.object({
  dedupKey: z.string(),
  description: z.string(),
  from: z.string().optional().describe("The category before, absent when nothing matched"),
  to: z.string().optional().describe("The category after, absent when the proposal leaves it uncategorised"),
});
export type ChangeView = z.infer<typeof ChangeView>;

export const EffectView = z.object({
  transactions: z.number().int().nonnegative(),
  outgoing: minorUnits("Money that left the household across this group"),
  merchants: z.number().int().nonnegative().describe("Distinct descriptions. The number that says whether a pattern has escaped."),
  entries: z.array(ChangeView).describe("The transactions themselves, truncated where `truncated` says so"),
  truncated: z
    .boolean()
    .describe("True when `entries` holds fewer than `transactions`. Never truncated silently."),
});
export type EffectView = z.infer<typeof EffectView>;

export const IntroducedConflictView = z.object({
  setId: z.string(),
  categories: z.array(z.string()).describe("The categories the set would claim at once"),
  transactions: z.number().int().nonnegative(),
  example: z.string().describe("One description it would happen on"),
});
export type IntroducedConflictView = z.infer<typeof IntroducedConflictView>;

/**
 * What the proposal would do, computed by the server.
 *
 * Never supplied by the caller. A model-authored proposal carrying its own
 * account of its effect would defeat the arrangement in which deterministic
 * code checks the model.
 */
export const PredictionView = z.object({
  gained: EffectView.describe("Uncategorised before, categorised after"),
  lost: EffectView.describe("Categorised before, uncategorised after. Usually a conflict, and almost never intended."),
  recategorised: EffectView.describe("One category before, a different one after. The number to look hardest at."),
  unchanged: EffectView.describe("The proposal matched and agreed with what was there"),
  outranked: EffectView.describe("The proposal matched and lost to a higher-precedence set"),
  introducedConflicts: z.array(IntroducedConflictView),
  scanned: z.number().int().nonnegative(),
});
export type PredictionView = z.infer<typeof PredictionView>;

export const ProposalResponse = z.object({
  prediction: PredictionView,
  /**
   * What was written, absent on a dry run.
   *
   * A dry run computes and returns; it creates no version and no record.
   */
  proposed: z
    .array(z.object({ setId: z.string(), version: z.number().int().nonnegative() }))
    .optional()
    .describe("The versions created, absent on a dry run"),
});
export type ProposalResponse = z.infer<typeof ProposalResponse>;

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
  CATEGORISATION_ROUTES,
  CONNECT_PATHS,
  ROUTES,
  pathFor,
  type QueryParam,
  type Route,
} from "./routes.js";
