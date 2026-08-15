/**
 * Command line for the replay. Wiring only — the work is in `backfill.ts`.
 *
 *   TENANT=frost BUCKET=<name> TABLE=<name> npm run backfill -w @tightarse/transform
 *   ... -- --dry-run
 *
 * Point TABLE at a NEW table rather than the live one: the live table has a
 * stream that triggers the categoriser, so replaying into it re-runs
 * categorisation across everything, which costs money in model mode.
 */
import { S3Client } from "@aws-sdk/client-s3";
import { Ledger } from "@tightarse/ledger";
import { replay } from "./backfill.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const tenantId = requireEnv("TENANT");
  const bucket = requireEnv("BUCKET");
  const tableName = requireEnv("TABLE");
  const region = process.env["AWS_REGION"] ?? "eu-west-1";
  const dryRun = process.argv.includes("--dry-run");

  const result = await replay(
    { s3: new S3Client({ region }), ledger: new Ledger({ tableName, region }), bucket },
    { tenantId, dryRun },
  );

  if (!dryRun) {
    console.log(`\n${result.rows} rows written to ${tableName}`);
    for (const [h, n] of Object.entries(result.byHandler)) console.log(`  ${h.padEnd(9)} ${n}`);
  }

  if (result.failures.length > 0) {
    console.error(`\n${result.failures.length} object(s) failed`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error("backfill failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
