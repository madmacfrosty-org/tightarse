import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  TrueLayerClient,
  TrueLayerError,
  ENDPOINTS,
  MAX_HISTORY_MONTHS,
  historyFrom,
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

  const accountsRes = await deps.truelayer.get(tokens.accessToken, "/data/v1/accounts");
  await write("truelayer.accounts", null, accountsRes.body);

  const accounts = ((accountsRes.body as { results?: Array<{ account_id?: string }> }).results ?? [])
    .map((a) => a.account_id)
    .filter((id): id is string => Boolean(id));

  const from = historyFrom(opts.historyMonths ?? MAX_HISTORY_MONTHS, now);
  const to = now.toISOString().slice(0, 10);

  for (const accountId of accounts) {
    // Transactions first: they are the point, and if a later optional endpoint
    // fails we still have the data that matters.
    try {
      const res = await deps.truelayer.get(
        tokens.accessToken,
        `/data/v1/accounts/${accountId}/transactions?from=${from}&to=${to}`,
      );
      await write("truelayer.transactions", accountId, res.body, { from, to });
    } catch (err) {
      result.errors.push(`transactions ${accountId}: ${describe(err)}`);
    }

    for (const spec of ENDPOINTS) {
      if (!spec.perAccount) continue;
      try {
        const res = await deps.truelayer.get(tokens.accessToken, spec.path(accountId));
        await write(spec.dataset, accountId, res.body);
      } catch (err) {
        if (spec.optional && err instanceof TrueLayerError && err.isNotApplicable) {
          // First Direct returns 501 for standing orders on every account and
          // 403 for direct debits on accounts that have none. Neither is a
          // failure, and alarming on them would train everyone to ignore alarms.
          result.skipped.push(`${spec.dataset} ${accountId}`);
          continue;
        }
        result.errors.push(`${spec.dataset} ${accountId}: ${describe(err)}`);
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
