import { gunzipSync } from "node:zlib";
import { parseRawKey } from "@tightarse/schema";
import {
  handlerFor,
  mapAccount,
  mapBalance,
  isCardDataset,
  balanceReadingOf,
  stalenessSeconds,
  mapTransaction,
  type RawAccount,
  type RawBalance,
  type RawTransaction,
} from "./map.js";
import type { LedgerWrites, RawObjects } from "@tightarse/ports";

/** The envelope the uploader and fetcher write around every response. */
interface RawEnvelope {
  captureVersion: number;
  endpoint: string;
  accountId: string | null;
  fetchedAt: string;
  httpStatus: number;
  body: { results?: unknown[] };
}

export interface TransformResult {
  key: string;
  dataset: string;
  handler: string;
  rows: number;
  /**
   * Settled transactions in this object that arrived with no running balance.
   *
   * The running balance on each transaction is the primary balance data — a
   * balance endpoint is a point-in-time snapshot and cannot say how the
   * position moved. So a settled row without one is a gap in the series, and
   * this is what makes that observable. See #30.
   *
   * Counted for settled rows only. Pending transactions carry no running
   * balance by nature: there is no settled position to report yet, and TrueLayer
   * returns them on a separate endpoint.
   *
   * Absent rather than zero for objects that are not settled transactions, so
   * "nothing to count" and "counted nothing" stay distinguishable.
   */
  unanchored?: { card: number; account: number };
  /**
   * For a balance object, how far behind our request the provider's data was,
   * in seconds. Absent for anything else.
   *
   * Zero when the provider sent no timestamp: no evidence of staleness rather
   * than stale.
   */
  staleness?: number;
}

export interface TransformDeps {
  readonly raw: RawObjects;
  readonly ledger: LedgerWrites;
  readonly bucket: string;
}

/**
 * Transform one raw object into ledger rows.
 *
 * Deliberately keyed off a single object rather than a batch: that is what an
 * S3 event delivers, it means a failure isolates to one response rather than a
 * whole run, and replaying one dataset does not require reprocessing
 * everything. Every write it makes is idempotent, so re-running is safe.
 */
export async function transformObject(deps: TransformDeps, key: string): Promise<TransformResult> {
  const { tenantId, dataset, accountId: keyAccountId } = parseRawKey(key);
  const handler = handlerFor(dataset);

  if (handler === "ignore") {
    return { key, dataset, handler, rows: 0 };
  }

  const env = await readObject(deps, key);

  // Non-2xx responses should not be in the landing zone at all, but a fetcher
  // change could put them there. Refusing beats writing rows from an error body.
  if (env.httpStatus < 200 || env.httpStatus >= 300) {
    throw new Error(`Refusing to transform a non-2xx response (${env.httpStatus}): ${key}`);
  }

  const results = env.body.results ?? [];
  const accountId = keyAccountId ?? env.accountId ?? undefined;

  switch (handler) {
    case "settled": {
      if (!accountId) throw new Error(`Transactions with no account in the key: ${key}`);
      const raw = results as RawTransaction[];
      const isCard = isCardDataset(dataset);
      // Card-ness is a fact about which endpoint answered, not something to
      // look up on an account. It is needed only to normalise runningBalance.
      const txns = raw.map((r) => mapTransaction(r, { tenantId, accountId, status: "settled", isCard }));
      await deps.ledger.putTransactions(txns, { sourceObject: key });

      // Split by card, because that is the question we could not answer from
      // the provider's documentation: it marks running_balance optional on both
      // endpoints and documents no rule for when it is present. Which of our
      // accounts actually omit it is a matter of observation, and a total would
      // not say whether Amex is the one behaving differently.
      const missing = raw.filter((r) => r.running_balance === undefined).length;
      return {
        key,
        dataset,
        handler,
        rows: txns.length,
        unanchored: { card: isCard ? missing : 0, account: isCard ? 0 : missing },
      };
    }

    case "pending": {
      if (!accountId) throw new Error(`Pending transactions with no account in the key: ${key}`);
      const txns = (results as RawTransaction[]).map((r) =>
        // Pending rows carry no running balance, so isCard changes nothing
        // here. Passed anyway, so the two branches cannot drift.
        mapTransaction(r, { tenantId, accountId, status: "pending", isCard: isCardDataset(dataset) }),
      );
      // Replace, never merge — an empty result means everything cleared, which
      // is a normal outcome and must delete the previous set.
      await deps.ledger.replacePending(tenantId, accountId, txns);
      return { key, dataset, handler, rows: txns.length };
    }

    case "accounts": {
      // Card-ness comes from the dataset — i.e. from which endpoint TrueLayer
      // returned this — because no field in the payload reliably says so.
      const isCard = isCardDataset(dataset);
      const accounts = (results as RawAccount[]).map((r) => mapAccount(r, { tenantId, isCard }));
      for (const a of accounts) await deps.ledger.putAccount(a);
      return { key, dataset, handler, rows: accounts.length };
    }

    case "balance": {
      if (!accountId) throw new Error(`Balance with no account in the key: ${key}`);
      const raw = (results as RawBalance[])[0];
      if (!raw) return { key, dataset, handler, rows: 0 };
      // Balances only. This used to upsert a whole minimal account row so a
      // balance arriving before its account was not dropped — but the
      // placeholders it invented ("unknown", the id as display name) then
      // overwrote the real details, and every current account in the ledger
      // ended up attributed to institution "unknown".
      await deps.ledger.putBalances(tenantId, accountId, {
        ...mapBalance(raw),
        currency: raw.currency,
        // The dataset already establishes this — the line below relies on it —
        // and writing it means a row created by a balance arriving first is
        // still readable. Without it the row has a balance and no way to tell
        // whether it is held or owed, and the dashboard was reading the absence
        // as "not a card" (#29).
        isCard: isCardDataset(dataset),
      });

      // And keep the reading, rather than only the latest figure.
      //
      // putBalances overwrites, so the ledger held exactly one balance per
      // account and there was nothing to reconcile against. Reconciliation
      // needs two readings and the transactions between them, which is the only
      // check that covers cards — they carry no running balance at all.
      //
      // The raw zone already holds every fetch, so a replay rebuilds the whole
      // series from objects we have had all along.
      const reading = balanceReadingOf(raw, {
        tenantId,
        accountId,
        fetchedAt: env.fetchedAt,
        isCard: isCardDataset(dataset),
      });
      await deps.ledger.putBalanceReading(reading);
      return { key, dataset, handler, rows: 1, staleness: stalenessSeconds(reading) };
    }

    default:
      throw new Error(`Unhandled handler "${handler}" for dataset "${dataset}"`);
  }
}

async function readObject(deps: TransformDeps, key: string): Promise<RawEnvelope> {
  const body = await deps.raw.get(key);
  // The adapter refuses an object with no body at all; this refuses one that
  // exists and contains nothing. They are different failures — a missing stream
  // is storage misbehaving, zero bytes is a fetch that stored an empty response —
  // and treating the second as "no rows" would silently transform nothing.
  if (body.length === 0) throw new Error(`Empty object: ${key}`);

  // The uploader gzips and sets Content-Encoding, but S3 does not decompress on
  // read, so this is always our job. Sniffing the magic bytes is more robust
  // than trusting the header, which a manual upload could omit.
  const buf = Buffer.from(body);
  const json = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf).toString() : buf.toString();
  return JSON.parse(json) as RawEnvelope;
}
