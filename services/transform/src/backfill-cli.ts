/**
 * Command line for the replay. Wiring only — the work is in `backfill.ts`.
 *
 *   TENANT=frost BUCKET=<name> TABLE=<name> npm run backfill -w @tightarse/transform
 *   ... -- --dry-run
 *   DATASETS=truelayer.balance,truelayer.card_balance ...   only those datasets
 *
 * Prefer a NEW table over the live one. A replay into live is safe but rewrites
 * `ingestedAt` on every row it touches, which is stamped at write time and
 * cannot be recovered — so limit it with DATASETS when only part of the ledger
 * needs rebuilding.
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
  // DATASETS=truelayer.balance,truelayer.card_balance replays only those.
  const datasets = process.env["DATASETS"]?.split(",").map((d) => d.trim()).filter(Boolean);

  const result = await replay(
    { s3: new S3Client({ region }), ledger: new Ledger({ tableName, region }), bucket },
    { tenantId, dryRun, ...(datasets?.length ? { datasets } : {}) },
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
