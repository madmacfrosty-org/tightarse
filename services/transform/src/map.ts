import {
  toMinorUnits,
  type Account,
  type Transaction,
  type TransactionStatus,
} from "@tightarse/schema";

/**
 * Provider response → domain objects. Pure: no S3, no DynamoDB, no clock.
 *
 * Everything here is derived from what First Direct actually returned during
 * the spike, not from the documented shape. Where the two differed, the
 * observed behaviour wins and the difference is noted.
 */

/** A transaction exactly as TrueLayer sends it. */
export interface RawTransaction {
  timestamp: string;
  description: string;
  transaction_type: string;
  transaction_category?: string;
  transaction_classification?: string[];
  amount: number;
  currency: string;
  transaction_id: string;
  provider_transaction_id?: string;
  normalised_provider_transaction_id?: string;
  merchant_name?: string;
  /** An object, `{currency, amount}` — not a scalar. Absent on pending rows. */
  running_balance?: { currency: string; amount: number };
  meta?: Record<string, unknown>;
}

export interface RawAccount {
  account_id: string;
  account_type?: string;
  display_name?: string;
  currency: string;
  update_timestamp?: string;
  provider?: { display_name?: string; provider_id?: string };
  /** Deliberately not mapped — see below. */
  account_number?: Record<string, string>;
}

export interface RawBalance {
  currency: string;
  current?: number;
  available?: number;
  overdraft?: number;
  update_timestamp?: string;
}

export function mapTransaction(
  raw: RawTransaction,
  ctx: {
    tenantId: string;
    accountId: string;
    status: TransactionStatus;
    /**
     * Whether this came from a card endpoint.
     *
     * Used for `runningBalance` and NOTHING ELSE. In particular it must never
     * touch `amount`: the sign there comes from `transaction_type`, because the
     * two datasets disagree on sign and agree perfectly on type, and that is
     * what makes card and account transactions uniform. Deriving direction from
     * card-ness instead would reintroduce the inversion that made every card
     * purchase read as income for five years.
     *
     * `mapTransactionSignsAmountFromType` in the tests fails if that changes.
     */
    isCard?: boolean;
  },
): Transaction {
  // Amounts arrive in major units as JSON floats. toMinorUnits rounds and uses
  // the currency's own exponent — a hardcoded 100 is wrong for JPY and KWD.
  const magnitude = Math.abs(toMinorUnits(raw.amount, raw.currency));

  const transactionType = raw.transaction_type === "CREDIT" ? "CREDIT" : "DEBIT";

  // The ledger's one sign convention: negative leaves the household, positive
  // arrives. The provider does NOT supply this consistently — it reports each
  // resource from that resource's own point of view:
  //
  //   current account   DEBIT → negative   CREDIT → positive   (8760 / 408)
  //   credit card       DEBIT → POSITIVE   CREDIT → NEGATIVE   ( 171 /  20)
  //
  // A card purchase increases what you owe, so the issuer calls it positive.
  // Storing that verbatim made every card purchase income and every card
  // payment spending, and left the two legs of a card bill payment with the
  // same sign, so transfer detection — which pairs a debit with a credit —
  // could never match them and never netted them out.
  //
  // Taking the sign from transaction_type instead of the amount is what makes
  // this uniform. Both datasets agree perfectly on the type; it is only the
  // sign that flips, so the type is the trustworthy half.
  const amount = transactionType === "DEBIT" ? -magnitude : magnitude;

  // Empty arrays are dropped rather than stored. First Direct returns no
  // classification at all, so an empty array here would be a misleading
  // "we looked and found nothing" instead of "the provider does not supply it".
  const classification =
    raw.transaction_classification && raw.transaction_classification.length > 0
      ? raw.transaction_classification
      : undefined;

  return {
    tenantId: ctx.tenantId,
    accountId: ctx.accountId,
    transactionId: raw.transaction_id,
    ...(raw.provider_transaction_id ? { providerTransactionId: raw.provider_transaction_id } : {}),
    ...(raw.normalised_provider_transaction_id
      ? { normalisedProviderTransactionId: raw.normalised_provider_transaction_id }
      : {}),
    timestamp: raw.timestamp,
    amount,
    currency: raw.currency,
    description: raw.description,
    ...(raw.merchant_name ? { merchantName: raw.merchant_name } : {}),
    status: ctx.status,
    transactionType,
    ...(raw.running_balance ? { runningBalance: runningBalanceOf(raw, ctx.isCard ?? false) } : {}),
    ...(raw.transaction_category ? { providerCategory: raw.transaction_category } : {}),
    ...(classification ? { providerClassification: classification } : {}),
  };
}

/**
 * The running balance, in the household's convention.
 *
 * The provider reports each resource from that resource's own point of view,
 * and the documentation is explicit that balances invert for cards:
 *
 *   account   negative = funds owed to the provider, i.e. an overdraft
 *   card      POSITIVE = money owed to the provider by the cardholder
 *
 * One convention here, the same as `amount`: negative is money the household
 * does not have. So an account's running balance passes through and a card's is
 * negated. Storing them verbatim would make a £2,000 card debt and £2,000 in
 * savings the same number, and any sum across accounts would be wrong by twice
 * the debt.
 *
 * Normalised at the boundary rather than at the point of use, so nothing
 * downstream has to know which kind of account a transaction came from — which
 * is what takes `isCard` off the critical path entirely.
 */
export function runningBalanceOf(raw: RawTransaction, isCard: boolean): number {
  const balance = toMinorUnits(raw.running_balance!.amount, raw.running_balance!.currency);
  return isCard ? -balance : balance;
}

/**
 * Account rows are sync and reconciliation state, not a display model — the
 * product is a single aggregated ledger, so account names never appear beside
 * transactions.
 *
 * `account_number` (sort code, number, IBAN, BIC) is deliberately not carried
 * across. Nothing downstream reads it, and putting bank details in a second
 * store to serve no purpose is a cost with no benefit. Raw still has it if
 * transfer matching ever wants corroboration.
 */
export function mapAccount(
  raw: RawAccount,
  ctx: { tenantId: string; isCard?: boolean },
): Account {
  return {
    tenantId: ctx.tenantId,
    accountId: raw.account_id,
    provider: "truelayer",
    providerAccountId: raw.account_id,
    displayName: raw.display_name ?? raw.account_id,
    institutionName: raw.provider?.display_name ?? "unknown",
    currency: raw.currency,
    // From the endpoint, not inferred from the numbers. Amex reports no
    // available balance, so a heuristic based on one showed a debt as credit.
    isCard: ctx.isCard ?? false,
    ...(raw.account_type ? { accountType: raw.account_type } : {}),
    ...(raw.update_timestamp ? { lastSyncedAt: raw.update_timestamp } : {}),
  };
}

/** Whether a dataset describes cards rather than bank accounts. */
export function isCardDataset(dataset: string): boolean {
  return dataset.startsWith("truelayer.card");
}

export function mapBalance(raw: RawBalance): { current?: number; available?: number } {
  return {
    ...(raw.current !== undefined ? { current: toMinorUnits(raw.current, raw.currency) } : {}),
    ...(raw.available !== undefined ? { available: toMinorUnits(raw.available, raw.currency) } : {}),
  };
}

/** Which datasets this transform knows how to handle, and as what. */
export const DATASET_HANDLERS = {
  "truelayer.transactions": "settled",
  "truelayer.card_transactions": "settled",
  "truelayer.transactions_pending": "pending",
  "truelayer.card_transactions_pending": "pending",
  "truelayer.accounts": "accounts",
  "truelayer.account": "accounts",
  "truelayer.card": "accounts",
  "truelayer.cards": "accounts",
  "truelayer.balance": "balance",
  "truelayer.card_balance": "balance",
  // Known and deliberately ignored: identity and connection metadata belong in
  // the raw zone for audit, but nothing in the ledger reads them.
  "truelayer.info": "ignore",
  "truelayer.me": "ignore",
  "truelayer.direct_debits": "ignore",
  "truelayer.standing_orders": "ignore",
} as const;

export type DatasetHandler = (typeof DATASET_HANDLERS)[keyof typeof DATASET_HANDLERS];

export function handlerFor(dataset: string): DatasetHandler {
  const h = (DATASET_HANDLERS as Record<string, DatasetHandler | undefined>)[dataset];
  if (!h) {
    // Failing loudly beats silently skipping: a dataset we do not recognise
    // means the fetcher started producing something the ledger does not know
    // about, and quietly dropping it would lose data indefinitely.
    throw new Error(`No handler for dataset "${dataset}"`);
  }
  return h;
}
