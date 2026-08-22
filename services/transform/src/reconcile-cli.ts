/**
 * Run the reconciliation over a household. Wiring only — the work is the
 * `reconcile` use case in @tightarse/domain.
 *
 *   TENANT=frost TABLE=<name> npm run reconcile -w @tightarse/transform
 *
 * Point TABLE at a table replayed from the raw zone before pointing it at the
 * live one: this writes dirty marks, and a replayed table is the place to find
 * out what the check actually says about five years of real data.
 */

import { DynamoTableRows, DynamoStore } from "@tightarse/dynamodb";
import { emit } from "@tightarse/metrics";
import { reconcile } from "@tightarse/domain";
import { scanAll, type Row } from "./compare.js";
import { dataFrom, groupForReconciliation, reconciliationLines, reconciliationMetrics } from "./reconcile-job.js";

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
  const tableName = requireEnv("TABLE");
  const region = process.env["AWS_REGION"] ?? "eu-west-1";
  const environment = process.env["ENVIRONMENT"] ?? "dev";
  const endpoint = process.env["LEDGER_TEST_ENDPOINT"];

  const ledger = new DynamoStore({ tableName, region, ...(endpoint ? { endpoint } : {}) });
  // One scan, then everything is grouped in memory. This ledger is small enough
  // that a query per account per kind would be more calls for no benefit.
  const rows: Row[] = [
    ...(await scanAll(new DynamoTableRows({ tableName, region, ...(endpoint ? { endpoint } : {}) }))),
  ];

  // The same grouping the scheduled job uses. It was duplicated here, and the
  // copy left out `firstSeenAt` — so this reported breaks for late settlers that
  // the job correctly explained, on the same data.
  const cards = new Set(groupForReconciliation(rows).accounts.filter((a) => a.isCard).map((a) => a.accountId));
  const isCard = (id: string) => cards.has(id);
  const result = await reconcile({ data: dataFrom(rows), marks: ledger }, tenantId);
  for (const line of reconciliationLines(result, isCard)) console.log(line);

  console.log(`\n${Object.keys(result.accounts).length} accounts, ${result.checked} checks, ${result.breaks} breaks`);
  emit({ namespace: "Tightarse", environment, metrics: reconciliationMetrics(result, isCard), properties: { tenantId } });

  if (result.breaks > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error("reconcile failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
