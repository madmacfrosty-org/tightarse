import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  TrueLayerClient,
  TrueLayerError,
  PER_ITEM_ENDPOINTS,
  RESOURCES,
  MAX_HISTORY_MONTHS,
  historyFrom,
  itemDataset,
  listDataset,
  transactionsDataset,
  type Resource,
} from "@tightarse/truelayer";
import { rawObjectKey } from "@tightarse/schema";
import type { Connection, Connections } from "./connections.js";

/**
 * One sync: refresh the token, fetch every endpoint, land each response in the
 * raw zone.
 *
 * Writes raw and nothing else. The transform picks up from the S3 event, so a
 * failure here can never leave the ledger half-written, and a fetch is
 * replayable without touching the bank.
 */

export interface SyncDeps {
  readonly truelayer: TrueLayerClient;
  readonly connections: Connections;
  readonly s3: S3Client;
  readonly bucket: string;
}

export interface SyncResult {
  connectionId: string;
  objectsWritten: number;
  /** Endpoints the provider does not offer — recorded, not retried. */
  skipped: string[];
  errors: string[];
  consentExpired: boolean;
}

export async function syncConnection(
  deps: SyncDeps,
  connection: Connection,
  opts: { historyMonths?: number; now?: Date } = {},
): Promise<SyncResult> {
  const now = opts.now ?? new Date();
  const result: SyncResult = {
    connectionId: connection.connectionId,
    objectsWritten: 0,
    skipped: [],
    errors: [],
    consentExpired: false,
  };

  let tokens;
  try {
    tokens = await deps.truelayer.refresh(connection.refreshToken);
  } catch (err) {
    if (err instanceof TrueLayerError && err.isConsentExpired) {
      // Not retryable by anything automated. Reported so a human is told to
      // reconnect, rather than the feed simply going quiet.
      result.consentExpired = true;
      return result;
    }
    throw err;
  }

  // Persist immediately and unconditionally: the token may have rotated, and
  // an unsaved rotation kills the connection on the next run.
  await deps.connections.update({ ...connection, refreshToken: tokens.refreshToken });

  const write = async (dataset: string, accountId: string | null, body: unknown, params: Record<string, string> = {}) => {
    const payload = JSON.stringify({
      captureVersion: 1,
      environment: process.env["TL_ENV"] ?? "live",
      endpoint: dataset,
      params,
      accountId,
      fetchedAt: new Date().toISOString(),
      httpStatus: 200,
      body,
    });
    const key = rawObjectKey({
      tenantId: connection.tenantId,
      dataset,
      accountId: accountId ?? undefined,
      fetchedAt: new Date().toISOString(),
      contentHash: createHash("sha256").update(payload).digest("hex"),
    });
    await deps.s3.send(
      new PutObjectCommand({
        Bucket: deps.bucket,
        Key: key,
        Body: gzipSync(Buffer.from(payload), { level: 9 }),
        ContentType: "application/json",
        ContentEncoding: "gzip",
        Tagging: new URLSearchParams({
          tenant: connection.tenantId,
          layer: "raw",
          dataset,
        }).toString(),
      }),
    );
    result.objectsWritten += 1;
  };

  const from = historyFrom(opts.historyMonths ?? MAX_HISTORY_MONTHS, now);
  const to = now.toISOString().slice(0, 10);

  for (const resource of RESOURCES) {
    let items: string[];
    try {
      const listRes = await deps.truelayer.get(tokens.accessToken, `/data/v1/${resource}`);
      await write(listDataset(resource), null, listRes.body);
      items = ((listRes.body as { results?: Array<{ account_id?: string }> }).results ?? [])
        .map((a) => a.account_id)
        .filter((id): id is string => Boolean(id));
    } catch (err) {
      // A provider may offer only one of the two. Amex is cards-only, with no
      // `accounts` scope at all, so a missing resource is a normal shape rather
      // than a failure — and treating it as fatal would abort the whole sync
      // before anything was fetched.
      if (err instanceof TrueLayerError && err.isNotApplicable) {
        result.skipped.push(resource);
        continue;
      }
      result.errors.push(`${resource}: ${describe(err)}`);
      continue;
    }

    for (const itemId of items) {
      // Transactions first: they are the point, so if a later optional endpoint
      // fails we still have the data that matters.
      try {
        const res = await deps.truelayer.get(
          tokens.accessToken,
          `/data/v1/${resource}/${itemId}/transactions?from=${from}&to=${to}`,
        );
        await write(transactionsDataset(resource), itemId, res.body, { from, to });
      } catch (err) {
        result.errors.push(`${transactionsDataset(resource)} ${itemId}: ${describe(err)}`);
      }

      try {
        const res = await deps.truelayer.get(tokens.accessToken, `/data/v1/${resource}/${itemId}`);
        await write(itemDataset(resource), itemId, res.body);
      } catch (err) {
        result.errors.push(`${itemDataset(resource)} ${itemId}: ${describe(err)}`);
      }

      for (const spec of PER_ITEM_ENDPOINTS) {
        const dataset = spec.dataset(resource);
        try {
          const res = await deps.truelayer.get(
            tokens.accessToken,
            `/data/v1/${resource}/${itemId}/${spec.suffix}`,
          );
          await write(dataset, itemId, res.body);
        } catch (err) {
          if (spec.optional && err instanceof TrueLayerError && err.isNotApplicable) {
            // First Direct returns 501 for standing orders on every account and
            // 403 for direct debits where there are none. Alarming on those
            // trains everyone to ignore alarms.
            result.skipped.push(`${dataset} ${itemId}`);
            continue;
          }
          result.errors.push(`${dataset} ${itemId}: ${describe(err)}`);
        }
      }
    }
  }

  await deps.connections.update({
    ...connection,
    refreshToken: tokens.refreshToken,
    lastSyncedAt: new Date().toISOString(),
  });

  return result;
}

function describe(err: unknown): string {
  if (err instanceof TrueLayerError) return `${err.status} ${err.code ?? ""}`.trim();
  return err instanceof Error ? err.message : String(err);
}
