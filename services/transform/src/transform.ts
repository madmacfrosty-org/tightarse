import { gunzipSync } from "node:zlib";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { parseRawKey } from "@tightarse/schema";
import { Ledger } from "@tightarse/ledger";
import {
  handlerFor,
  mapAccount,
  mapBalance,
  isCardDataset,
  mapTransaction,
  type RawAccount,
  type RawBalance,
  type RawTransaction,
} from "./map.js";

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
}

export interface TransformDeps {
  readonly s3: S3Client;
  readonly ledger: Ledger;
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
      const txns = (results as RawTransaction[]).map((r) =>
        mapTransaction(r, { tenantId, accountId, status: "settled" }),
      );
      await deps.ledger.putTransactions(txns, { sourceObject: key });
      return { key, dataset, handler, rows: txns.length };
    }

    case "pending": {
      if (!accountId) throw new Error(`Pending transactions with no account in the key: ${key}`);
      const txns = (results as RawTransaction[]).map((r) =>
        mapTransaction(r, { tenantId, accountId, status: "pending" }),
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
      });
      return { key, dataset, handler, rows: 1 };
    }

    default:
      throw new Error(`Unhandled handler "${handler}" for dataset "${dataset}"`);
  }
}

async function readObject(deps: TransformDeps, key: string): Promise<RawEnvelope> {
  const res = await deps.s3.send(new GetObjectCommand({ Bucket: deps.bucket, Key: key }));
  const body = await res.Body?.transformToByteArray();
  if (!body) throw new Error(`Empty object: ${key}`);

  // The uploader gzips and sets Content-Encoding, but S3 does not decompress on
  // read, so this is always our job. Sniffing the magic bytes is more robust
  // than trusting the header, which a manual upload could omit.
  const buf = Buffer.from(body);
  const json = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf).toString() : buf.toString();
  return JSON.parse(json) as RawEnvelope;
}
