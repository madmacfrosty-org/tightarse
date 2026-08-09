/**
 * Replay every raw object for a tenant through the transform.
 *
 * This is the backfill component: the same code path an S3 event drives, run
 * over a prefix instead. It exists because every write is idempotent, so
 * re-running the whole landing zone converges rather than duplicating — which
 * is the entire reason raw is kept.
 *
 * Usage:
 *   TENANT=frost BUCKET=<name> TABLE=<name> node src/backfill.ts [--dry-run]
 */

import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { Ledger } from "@tightarse/ledger";
import { transformObject } from "./transform.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const tenantId = requireEnv("TENANT");
  const bucket = requireEnv("BUCKET");
  const tableName = requireEnv("TABLE");
  const region = process.env["AWS_REGION"] ?? "eu-west-1";
  const dryRun = process.argv.includes("--dry-run");

  const s3 = new S3Client({ region });
  const ledger = new Ledger({ tableName, region });

  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `tenant=${tenantId}/`,
        ...(token ? { ContinuationToken: token } : {}),
      }),
    );
    for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = res.NextContinuationToken;
  } while (token);

  console.log(`${keys.length} objects under tenant=${tenantId}${dryRun ? " (dry run)" : ""}\n`);

  let rows = 0;
  const byHandler: Record<string, number> = {};
  const failures: Array<{ key: string; error: string }> = [];

  // Sequential on purpose. Ordering matters for accounts before balances, the
  // volume is small, and a stampede of parallel writes would only make a
  // partial failure harder to reason about.
  for (const key of keys) {
    try {
      if (dryRun) {
        console.log(`  would transform  ${key}`);
        continue;
      }
      const r = await transformObject({ s3, ledger, bucket }, key);
      rows += r.rows;
      byHandler[r.handler] = (byHandler[r.handler] ?? 0) + r.rows;
      console.log(`  ${String(r.rows).padStart(5)} rows  ${r.handler.padEnd(9)}  ${r.dataset}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ key, error: message });
      console.error(`  FAILED  ${key}\n          ${message}`);
    }
  }

  if (!dryRun) {
    console.log(`\n${rows} rows written`);
    for (const [h, n] of Object.entries(byHandler)) console.log(`  ${h.padEnd(9)} ${n}`);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} object(s) failed`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("backfill failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
