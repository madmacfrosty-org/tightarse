/**
 * Run the reconciliation over a household. Wiring only — the work is in
 * `reconcile.ts` and `reconcile-phase.ts`.
 *
 *   TENANT=frost TABLE=<name> npm run reconcile -w @tightarse/transform
 *
 * Point TABLE at a table replayed from the raw zone before pointing it at the
 * live one: this writes dirty marks, and a replayed table is the place to find
 * out what the check actually says about five years of real data.
 */

import { Ledger } from "@tightarse/ledger";
import { emit } from "@tightarse/metrics";
import { runReconciliation } from "./reconcile-phase.js";
import { rowKind, scanAll, type Row } from "./compare.js";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

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

  const ledger = new Ledger({ tableName, region, ...(endpoint ? { endpoint } : {}) });
  const doc = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region,
      ...(endpoint ? { endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" } } : {}),
    }),
  );

  // One scan, then everything is grouped in memory. This ledger is small enough
  // that a query per account per kind would be more calls for no benefit.
  const rows: Row[] = await scanAll(doc, tableName);
  const byAccount = <T>(kind: string, pick: (r: Row) => T): Map<string, T[]> => {
    const out = new Map<string, T[]>();
    for (const r of rows) {
      if (rowKind(r) !== kind) continue;
      const id = String(r["accountId"]);
      out.set(id, [...(out.get(id) ?? []), pick(r)]);
    }
    return out;
  };

  const readings = byAccount("balanceReading", (r) => ({
    accountId: String(r["accountId"]),
    fetchedAt: String(r["fetchedAt"]),
    balance: Number(r["balance"]),
  }));
  const movements = byAccount("transaction", (r) => ({
    timestamp: String(r["timestamp"]),
    amount: Number(r["amount"]),
  }));
  const accounts = rows
    .filter((r) => rowKind(r) === "account")
    .map((r) => ({ accountId: String(r["accountId"]), isCard: r["isCard"] === true }));

  const result = await runReconciliation({
    accounts: async () => accounts,
    readings: async (id) => readings.get(id) ?? [],
    movements: async (id) => movements.get(id) ?? [],
    markDirty: (id, fetchedAt, discrepancy) =>
      ledger.markBalanceReadingDirty(tenantId, id, fetchedAt, discrepancy),
    clearDirty: (id, fetchedAt) => ledger.clearBalanceReadingDirty(tenantId, id, fetchedAt),
  });

  console.log(`\n${result.accounts} accounts, ${result.checked} checks, ${result.breaks} breaks`);
  emit({ namespace: "Tightarse", environment, metrics: result.metrics, properties: { tenantId } });

  if (result.breaks > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error("reconcile failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
