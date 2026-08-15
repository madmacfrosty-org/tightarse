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
 * Point TABLE at a NEW table rather than the live one. The live table has a
 * DynamoDB stream that triggers the categoriser, so replaying into it re-runs
 * categorisation across everything, which costs money in model mode. A fresh
 * table has no stream, and gives you something to compare against — see
 * `compare.ts`.
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
import { Ledger } from "@tightarse/ledger";
import { transformObject } from "./transform.js";

export interface ReplayDeps {
  readonly s3: S3Client;
  readonly ledger: Ledger;
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
  readonly log?: ((line: string) => void) | undefined;
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
  const keys = await listRawKeys(deps, opts.tenantId);

  write(`${keys.length} objects under tenant=${opts.tenantId}${opts.dryRun ? " (dry run)" : ""}\n`);

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
