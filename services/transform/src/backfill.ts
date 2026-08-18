/**
 * Replay every raw object for a tenant through the transform.
 *
 * The same code path an S3 event drives, run over a prefix instead. It exists
 * because every write is idempotent, so re-running the whole landing zone
 * converges rather than duplicating — which is the entire reason raw is kept.
 *
 * Usage:
 *   TENANT=frost BUCKET=<name> TABLE=<name> node src/backfill.ts [--dry-run]
 *
 * Prefer a NEW table over the live one, and compare the two — see `compare.ts`.
 * A replay into live is safe (every write is idempotent, demonstrated at 9,790
 * rows with zero differences) but it rewrites `ingestedAt` on every row it
 * touches, which is stamped at write time and cannot be recovered.
 *
 * The table has a DynamoDB stream enabled, but nothing consumes it today — the
 * categoriser runs on a schedule. So a replay does not re-run categorisation.
 * That will change the day something is wired to the stream, and this note is
 * here so the cost is reconsidered rather than assumed either way.
 *
 * ## Order does not matter
 *
 * This used to claim otherwise: "ordering matters for accounts before
 * balances". It never provided that guarantee — replay follows S3 lexicographic
 * order, and `dataset=truelayer.card_balance` sorts before
 * `dataset=truelayer.cards` because `_` precedes `s`, so card balances have
 * always been written first.
 *
 * A completed replay converges to the same state in any order:
 *
 *   - transactions are idempotent puts keyed by `dedupKey`
 *   - `putAccount` and `putBalances` are partial updates to one item touching
 *     mostly disjoint attributes; they overlap only on `currency`, where both
 *     write the same value
 *   - enrichments are produced by the categoriser, not here, so they are never
 *     replayed
 *
 * The one exception is `replacePending`, which replaces a whole set, so the
 * last pending object replayed for an account wins. That outcome is
 * order-dependent and does not matter only because nothing reads pending rows.
 * If pending is ever surfaced this comes back, quietly, because the replay
 * still succeeds and merely leaves a stale set.
 */

import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { DynamoStore } from "@tightarse/dynamodb";
import { transformObject } from "./transform.js";
import type { LedgerWrites } from "@tightarse/ports";

export interface ReplayDeps {
  readonly s3: S3Client;
  readonly ledger: LedgerWrites;
  readonly bucket: string;
}

export interface ReplayFailure {
  readonly key: string;
  readonly error: string;
}

export interface ReplayResult {
  /** Raw objects found under the tenant prefix. */
  readonly objects: number;
  /** Ledger rows written. Zero on a dry run. */
  readonly rows: number;
  readonly byHandler: Readonly<Record<string, number>>;
  readonly failures: readonly ReplayFailure[];
}

export interface ReplayOptions {
  readonly tenantId: string;
  readonly dryRun?: boolean;
  /**
   * Replay only these datasets, by exact name. Every dataset when absent.
   *
   * The reason it exists: replaying everything into the live table rewrites
   * `ingestedAt` on every transaction, which is stamped at write time, so a full
   * replay resets when each row is recorded as having arrived and loses that
   * information for good.
   *
   * A replay confined to the datasets that actually need rebuilding avoids
   * both. Against a fresh table there is no reason to filter and every reason
   * not to.
   */
  readonly datasets?: readonly string[] | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

/** Whether a raw object key belongs to one of the named datasets. */
export function keyMatchesDatasets(key: string, datasets?: readonly string[]): boolean {
  if (!datasets || datasets.length === 0) return true;
  // Matched on the whole path segment, so `truelayer.balance` cannot also
  // select `truelayer.card_balance`.
  return datasets.some((d) => key.includes(`/dataset=${d}/`));
}

/** Every raw object key under a tenant, following pagination to the end. */
export async function listRawKeys(deps: ReplayDeps, tenantId: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await deps.s3.send(
      new ListObjectsV2Command({
        Bucket: deps.bucket,
        Prefix: `tenant=${tenantId}/`,
        ...(token ? { ContinuationToken: token } : {}),
      }),
    );
    for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = res.NextContinuationToken;
  } while (token);
  return keys;
}

export async function replay(deps: ReplayDeps, opts: ReplayOptions): Promise<ReplayResult> {
  const write = opts.log ?? console.log;
  const all = await listRawKeys(deps, opts.tenantId);
  const keys = all.filter((k) => keyMatchesDatasets(k, opts.datasets));

  const scope = opts.datasets?.length ? ` of ${all.length}, limited to ${opts.datasets.join(", ")}` : "";
  write(`${keys.length} objects${scope} under tenant=${opts.tenantId}${opts.dryRun ? " (dry run)" : ""}\n`);

  let rows = 0;
  const byHandler: Record<string, number> = {};
  const failures: ReplayFailure[] = [];

  // Sequential. Not for correctness — see the note above — but because the
  // volume is small and a stampede of parallel writes would make a partial
  // failure harder to reason about.
  for (const key of keys) {
    if (opts.dryRun) {
      write(`  would transform  ${key}`);
      continue;
    }
    try {
      const r = await transformObject(deps, key);
      rows += r.rows;
      byHandler[r.handler] = (byHandler[r.handler] ?? 0) + r.rows;
      write(`  ${String(r.rows).padStart(5)} rows  ${r.handler.padEnd(9)}  ${r.dataset}`);
    } catch (err) {
      // Collected rather than thrown: one unreadable object should not hide
      // what the other two hundred did, and a partial replay you know the shape
      // of is more useful than a stack trace.
      const error = err instanceof Error ? err.message : String(err);
      failures.push({ key, error });
      write(`  FAILED  ${key}\n          ${error}`);
    }
  }

  return { objects: keys.length, rows, byHandler, failures };
}
