/**
 * Compare two ledger tables over the rows a replay produces.
 *
 *   LEFT=<live table> RIGHT=<replayed table> node src/compare-cli.ts
 *
 * Read-only on both. The intended use is:
 *
 *   1. create a fresh table
 *   2. replay the raw zone into it with backfill.ts
 *   3. run this against the live table and the fresh one
 *
 * A clean result is a demonstration that the landing zone can rebuild the
 * ledger. A difference is either a bug in a change to the transform, or a row
 * the raw zone cannot account for — both worth knowing.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { compareRows, formatReport, isMatch, scanAll } from "./compare.js";
import { DynamoTableRows } from "@tightarse/dynamodb";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const leftTable = requireEnv("LEFT");
  const rightTable = requireEnv("RIGHT");
  const region = process.env["AWS_REGION"] ?? "eu-west-1";
  const endpoint = process.env["LEDGER_TEST_ENDPOINT"];

  const doc = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region,
      ...(endpoint ? { endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" } } : {}),
    }),
  );

  // One adapter per table. Comparing two tables is the one case that genuinely
  // needs two, and binding the table name at construction is what stops a caller
  // scanning the wrong one by passing the wrong string.
  const [left, right] = await Promise.all([
    scanAll(new DynamoTableRows({ tableName: leftTable, region, ...(endpoint ? { endpoint } : {}) })),
    scanAll(new DynamoTableRows({ tableName: rightTable, region, ...(endpoint ? { endpoint } : {}) })),
  ]);
  console.log(`left   ${leftTable}  ${left.length} rows`);
  console.log(`right  ${rightTable}  ${right.length} rows\n`);

  const report = compareRows(left, right);
  console.log(formatReport(report));

  if (isMatch(report)) {
    console.log("\nMATCH — the raw zone rebuilds everything the transform produces.");
  } else {
    console.log("\nDIFFERENT — see above.");
    process.exitCode = 1;
  }
}

if (process.argv[1]?.includes("compare-cli")) {
  main().catch((err: unknown) => {
    console.error("compare failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
