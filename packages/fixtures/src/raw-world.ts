/**
 * A whole landing zone, generated: the raw provider objects an ingest run would
 * have written, for a household that does not exist.
 *
 * The point is not realistic-looking JSON. It is that the *relationships*
 * between objects hold, because those are what the pipeline depends on and what
 * a per-value generator gets wrong:
 *
 * - transactions come back **newest-first**, and `running_balance` chains along
 *   that array order. Timestamps are day-resolution, so they cannot recover the
 *   intra-day sequence and must not be used to sort.
 * - a **pending** transaction reappears as settled carrying the same
 *   `provider_transaction_id` and `normalised_provider_transaction_id`.
 * - a **direct debit mandate**'s `previous_payment_amount` is positive and
 *   matches a real transaction whose amount is negative. The sign flip is the
 *   provider's, and code comparing them naively matches nothing.
 * - **cards carry no running balance at all**, and their categories are only
 *   CREDIT/DEBIT — a card has no usable provider categorisation.
 *
 * **The clock is part of the seed.** There is one input, not two: the seed is a
 * moment in time, and the world's dates and its random stream both come out of
 * it. `seed: Date.now()` gives fresh, recent data that differs every run;
 * `seed: Date.parse("2026-01-15")` gives a fixed corpus a test can assert on.
 * Same seed, same world, dates included.
 *
 * Nothing here reads a clock of its own. A caller wanting variety supplies the
 * moment and must log it, or a failure stops being reproducible.
 */

import { seeded } from "./index.js";
import { int, pick, weighted, type Rng } from "./gen.js";
import {
  ATM_LOCATIONS,
  DIRECT_DEBIT_ORIGINATORS,
  EMPLOYERS,
  describableMerchants,
  PEOPLE,
  payeeName,
} from "./vocabulary.js";

const DAY = 86_400_000;

/** A generated raw object: where it goes, and what an ingest run would have written. */
export interface RawObject {
  /** The S3 key, matching the layout the transform reads. */
  readonly key: string;
  /** The envelope — our wrapper, not the provider's response alone. */
  readonly envelope: Record<string, unknown>;
}

export interface WorldOptions {
  /**
   * The moment the world ends, as epoch milliseconds — `Date.now()`, or a
   * parsed date for a fixed corpus.
   *
   * It seeds the random stream AND fixes the anchor date, so one value
   * determines the whole world. A seed outside a plausible range is rejected:
   * passing `1` would otherwise silently generate a household living in 1970.
   */
  readonly seed: number;
  /** How much history to produce. */
  readonly months?: number;
  /**
   * Which household these objects belong to.
   *
   * Generated from the seed when omitted, so a world is self-contained: two
   * seeds give two households that cannot collide in the same table, without a
   * caller having to invent names for them.
   */
  readonly tenant?: string;
}

/** 2001-09-09, the first ten-digit epoch second. Anything earlier is a mistaken seed. */
const EARLIEST_SEED = 1_000_000_000_000;

/** Minor units to the major-unit JSON number the provider actually sends. */
const major = (minor: number): number => Math.round(minor) / 100;

/** A day-resolution timestamp, which is all the provider gives. */
const dayStamp = (ms: number): string =>
  `${new Date(ms).toISOString().slice(0, 10)}T00:00:00Z`;

/** Stable pseudo-identifier. Hex, provider-shaped, derived from the rng not a hash of content. */
const idOf = (rng: Rng, len = 32): string =>
  Array.from(
    { length: len },
    () => "0123456789abcdef"[Math.floor(rng() * 16)]!,
  ).join("");

interface Txn {
  timestamp: string;
  amount: number; // minor units, signed: negative left the household
  description: string;
  category: string;
  transactionId: string;
  providerId: string;
  normalisedId: string;
}

/** One account transaction, before it knows its balance. */
function accountTxn(rng: Rng, atMs: number): Txn {
  const kind = weighted([
    [60, "merchant"],
    [10, "person"],
    [8, "atm"],
    [8, "directDebit"],
    [6, "standingOrder"],
  ] as const)(rng);

  const id = idOf(rng);
  const base = {
    timestamp: dayStamp(atMs),
    transactionId: id,
    providerId: idOf(rng, 24),
    normalisedId: idOf(rng, 24),
  };

  switch (kind) {
    case "merchant": {
      const m = pick(describableMerchants())(rng);
      return {
        ...base,
        amount: -int(m.spend[0], m.spend[1])(rng),
        description: m.description,
        category: "PURCHASE",
      };
    }
    case "person": {
      const p = pick(PEOPLE)(rng);
      const form = pick(["initial", "full", "surname"] as const)(rng);
      return {
        ...base,
        amount: -int(5_00, 250_00)(rng),
        description: `FASTER PAYMENT TO ${payeeName(p, form)}`,
        category: "BILL_PAYMENT",
      };
    }
    case "atm":
      return {
        ...base,
        amount: -int(10_00, 200_00)(rng),
        description: pick(ATM_LOCATIONS)(rng),
        category: "ATM",
      };
    case "directDebit": {
      const d = pick(DIRECT_DEBIT_ORIGINATORS)(rng);
      return {
        ...base,
        amount: -int(d.min, d.max)(rng),
        description: `${d.name} DD`,
        category: "DIRECT_DEBIT",
      };
    }
    case "standingOrder": {
      const p = pick(PEOPLE)(rng);
      return {
        ...base,
        amount: -int(50_00, 400_00)(rng),
        description: `SO ${payeeName(p, "initial")}`,
        category: "STANDING_ORDER",
      };
    }
  }
}

/**
 * One card transaction.
 *
 * Deliberately NOT the account mix. A card sees purchases and, every so often,
 * the payment that clears it — no salary, no direct debits, no standing orders.
 * Reusing the account generator put salary credits on a credit card, which
 * inflated income to something no household earns and would have made every
 * total built on this fixture quietly wrong.
 */
function cardTxn(rng: Rng, atMs: number): Txn {
  const base = {
    timestamp: dayStamp(atMs),
    transactionId: idOf(rng),
    providerId: idOf(rng, 24),
    normalisedId: idOf(rng, 24),
  };
  const clearing = weighted([
    [1, true],
    [11, false],
  ] as const)(rng);
  if (clearing) {
    return {
      ...base,
      amount: int(150_00, 900_00)(rng),
      description: "CARD PAYMENT THANK YOU",
      category: "CREDIT",
    };
  }
  const m = pick(describableMerchants())(rng);
  return {
    ...base,
    amount: -int(m.spend[0], m.spend[1])(rng),
    description: m.description,
    category: "DEBIT",
  };
}

/**
 * Attach running balances, newest-first.
 *
 * Generated backwards from the closing balance: the newest row's balance is the
 * closing figure, and each older row's balance is the one after it minus the
 * newer row's amount. That is the identity the real feed satisfies, and doing
 * it any other way produces a chain that looks right in isolation and fails the
 * moment two windows overlap.
 */
function withBalances(
  newestFirst: readonly Txn[],
  closingMinor: number,
): (Txn & { balance: number })[] {
  const out: (Txn & { balance: number })[] = [];
  let balance = closingMinor;
  for (const t of newestFirst) {
    out.push({ ...t, balance });
    balance -= t.amount;
  }
  return out;
}

const txnJson = (
  t: Txn & { balance?: number },
  isCard: boolean,
): Record<string, unknown> => ({
  transaction_id: t.transactionId,
  provider_transaction_id: t.providerId,
  normalised_provider_transaction_id: t.normalisedId,
  timestamp: t.timestamp,
  // The provider reports a card from the ISSUER's point of view, so a card
  // debit arrives positive. Reproduced deliberately: fixtures that agreed with
  // the account convention would ratify the most expensive bug this repo has had.
  amount: major(isCard ? -t.amount : t.amount),
  currency: "GBP",
  description: t.description,
  transaction_type: t.amount < 0 ? "DEBIT" : "CREDIT",
  transaction_category: isCard
    ? t.amount < 0
      ? "DEBIT"
      : "CREDIT"
    : t.category,
  transaction_classification: [],
  meta: {
    provider_id: t.providerId,
    provider_reference: t.description,
    transaction_type: t.amount < 0 ? "Debit" : "Credit",
  },
  ...(isCard || t.balance === undefined
    ? {}
    : { running_balance: { currency: "GBP", amount: major(t.balance) } }),
});

const envelope = (
  endpoint: string,
  accountId: string | null,
  results: unknown[],
  fetchedAt: string,
  params: Record<string, string> = {},
): Record<string, unknown> => ({
  endpoint,
  params,
  accountId,
  httpStatus: 200,
  fetchedAt,
  environment: "generated",
  captureVersion: 1,
  body: { status: "Succeeded", results },
});

const keyFor = (
  tenant: string,
  dataset: string,
  accountId: string | null,
  at: string,
  rng: Rng,
): string =>
  `tenant=${tenant}/dataset=${dataset}/account=${accountId ?? "-"}/` +
  `${at.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${idOf(rng, 12)}.json.gz`;

/**
 * Generate the objects.
 *
 * One connection, one current account and one credit card, which is the
 * smallest world exercising both sign conventions and both balance shapes.
 */
export function generateRawWorld(opts: WorldOptions): RawObject[] {
  if (!Number.isFinite(opts.seed) || opts.seed < EARLIEST_SEED) {
    throw new Error(
      `seed must be epoch milliseconds (got ${opts.seed}). The clock is part of the seed: ` +
        `pass Date.now() for fresh data, or Date.parse(...) for a fixed corpus.`,
    );
  }
  const rng = seeded(opts.seed);
  const months = opts.months ?? 12;
  const tenant = opts.tenant ?? `t-${idOf(rng, 10)}`;
  const anchor = new Date(opts.seed).toISOString().slice(0, 10);
  const endMs = Date.parse(`${anchor}T00:00:00Z`);
  const fetchedAt = `${anchor}T05:00:00.000Z`;
  const accountId = idOf(rng);
  const cardId = idOf(rng);
  const objects: RawObject[] = [];
  const add = (
    dataset: string,
    endpoint: string,
    id: string | null,
    results: unknown[],
    params = {},
  ): void => {
    objects.push({
      key: keyFor(tenant, dataset, id, fetchedAt, rng),
      envelope: envelope(endpoint, id, results, fetchedAt, params),
    });
  };

  // Transactions, newest-first, then balances chained backwards from closing.
  const count = int(months * 18, months * 34)(rng);
  const spending: Txn[] = [];
  for (let i = 0; i < count; i += 1) {
    spending.push(
      accountTxn(rng, endMs - Math.floor((i / count) * months * 30 * DAY)),
    );
  }

  // Salary is monthly, not one outcome of a weighted mix. Left in the mix it
  // fired at random and produced an income several times what the household
  // earns — a fixture that misrepresents the SHAPE of a ledger, rather than one
  // that merely differs from a particular ledger. A fixed pay day also gives
  // recurrence detection something real to find.
  const payDay = int(24, 28)(rng);
  const salaryAmount = int(2_100_00, 3_200_00)(rng);
  const employer = pick(EMPLOYERS)(rng);
  const salaries: Txn[] = [];
  for (let m = 0; m < months; m += 1) {
    const d = new Date(endMs);
    d.setUTCMonth(d.getUTCMonth() - m, payDay);
    if (d.getTime() > endMs) continue;
    salaries.push({
      timestamp: dayStamp(d.getTime()),
      amount: salaryAmount,
      description: employer,
      category: "CREDIT",
      transactionId: idOf(rng),
      providerId: idOf(rng, 24),
      normalisedId: idOf(rng, 24),
    });
  }

  const newestFirst = [...spending, ...salaries].sort((a, b) =>
    b.timestamp.localeCompare(a.timestamp),
  );
  const closing = int(-1_200_00, 4_500_00)(rng);
  const settled = withBalances(newestFirst, closing);

  // Pending: the newest few, carried over with identity intact so the settled
  // copy is discoverable by both provider ids — the property dedup relies on.
  const pending = settled.slice(0, int(1, 3)(rng));

  const cardCount = int(months * 8, months * 20)(rng);
  const cardTxns: Txn[] = [];
  for (let i = 0; i < cardCount; i += 1) {
    cardTxns.push(
      cardTxn(rng, endMs - Math.floor((i / cardCount) * months * 30 * DAY)),
    );
  }

  const from = new Date(endMs - months * 30 * DAY).toISOString().slice(0, 10);
  add(
    "truelayer.transactions",
    `/data/v1/accounts/${accountId}/transactions`,
    accountId,
    settled.map((t) => txnJson(t, false)),
    { from, to: anchor },
  );
  add(
    "truelayer.transactions_pending",
    `/data/v1/accounts/${accountId}/transactions/pending`,
    accountId,
    pending.map(({ balance: _b, ...t }) => txnJson(t, false)),
  );
  add(
    "truelayer.card_transactions",
    `/data/v1/cards/${cardId}/transactions`,
    cardId,
    cardTxns.map((t) => txnJson(t, true)),
    { from, to: anchor },
  );
  add(
    "truelayer.card_transactions_pending",
    `/data/v1/cards/${cardId}/transactions/pending`,
    cardId,
    [],
  );

  add("truelayer.accounts", "/data/v1/accounts", null, [
    accountJson(accountId, rng, fetchedAt),
  ]);
  add("truelayer.account", `/data/v1/accounts/${accountId}`, accountId, [
    accountJson(accountId, rng, fetchedAt),
  ]);
  add(
    "truelayer.balance",
    `/data/v1/accounts/${accountId}/balance`,
    accountId,
    [
      {
        currency: "GBP",
        available: major(closing),
        current: major(closing),
        update_timestamp: fetchedAt,
      },
    ],
  );

  add("truelayer.cards", "/data/v1/cards", null, [
    cardJson(cardId, rng, fetchedAt),
  ]);
  add("truelayer.card", `/data/v1/cards/${cardId}`, cardId, [
    cardJson(cardId, rng, fetchedAt),
  ]);
  const owed = cardTxns.reduce((n, t) => n + t.amount, 0);
  add("truelayer.card_balance", `/data/v1/cards/${cardId}/balance`, cardId, [
    {
      currency: "GBP",
      // Reported positive: what is OWED, from the issuer's point of view.
      current: major(Math.abs(owed)),
      credit_limit: 5_000_00 / 100,
      // Omitted on purpose for some cards. Code has previously inferred
      // card-ness from "available exceeds current" and been wrong.
      update_timestamp: fetchedAt,
    },
  ]);

  // A mandate whose previous payment really happened, with the sign flipped.
  const ddTxn = settled.find((t) => t.category === "DIRECT_DEBIT");
  if (ddTxn) {
    add(
      "truelayer.direct_debits",
      `/data/v1/accounts/${accountId}/direct_debits`,
      accountId,
      [
        {
          direct_debit_id: idOf(rng, 24),
          name: ddTxn.description.replace(/ DD$/, ""),
          status: "Active",
          currency: "GBP",
          timestamp: ddTxn.timestamp,
          previous_payment_amount: major(Math.abs(ddTxn.amount)),
          previous_payment_timestamp: ddTxn.timestamp,
          meta: {
            provider_account_id: accountId,
            provider_mandate_identification: idOf(rng, 12),
          },
        },
      ],
    );
  }
  return objects;
}

const accountJson = (
  id: string,
  rng: Rng,
  at: string,
): Record<string, unknown> => ({
  account_id: id,
  account_type: "TRANSACTION",
  display_name: "Current Account",
  currency: "GBP",
  account_number: {
    iban: `GB00SYNT${int(10_000_000, 99_999_999)(rng)}`,
    number: String(int(10_000_000, 99_999_999)(rng)),
    sort_code: "00-00-00",
    swift_bic: "SYNTGB2L",
  },
  provider: {
    display_name: "Synthetic Bank",
    provider_id: "ob-synthetic",
    logo_uri: "https://example.invalid/logo.svg",
  },
  update_timestamp: at,
});

const cardJson = (
  id: string,
  rng: Rng,
  at: string,
): Record<string, unknown> => ({
  account_id: id,
  card_network: pick(["AMEX", "MASTERCARD"] as const)(rng),
  card_type: "CREDIT",
  display_name: "Credit Card",
  name_on_card: payeeName(pick(PEOPLE)(rng), "full"),
  partial_card_number: String(int(1000, 9999)(rng)),
  currency: "GBP",
  provider: {
    display_name: "Synthetic Bank",
    provider_id: "ob-synthetic",
    logo_uri: "https://example.invalid/logo.svg",
  },
  update_timestamp: at,
});
