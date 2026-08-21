/**
 * Reconciliation: does the ledger's arithmetic agree with the bank's?
 *
 * The job, not the Lambda. This reads a table, reconciles it and reports; it
 * constructs nothing. `reconcile-handler.ts` next to it is the entry point that
 * builds the adapters and calls in here, which is the only reason the two are
 * separate files.
 *
 * Run on a schedule rather than as part of the transform, because the transform
 * runs once per raw object with no ordering between them — a balance reading and the
 * transactions it should be checked against arrive as separate S3 events, in
 * whatever order Lambda schedules them. Checking at write time would compare
 * against whatever had happened to land.
 *
 * Runs after the sync and after the categoriser, so it sees a settled ledger.
 */

import type { DynamoStore } from "@tightarse/dynamodb";
import { emit } from "@tightarse/metrics";
import { rowKind, scanAll, type Row } from "./compare.js";
import { reconcile, type ReconciliationReport } from "@tightarse/domain";
import type {
  ReconciliationMovement,
  ReconcilableAccount,
  Reading,
  ReconciliationData,
  ReconciliationMarks,
  TableRows,
} from "@tightarse/domain";

export interface ReconcileConfig {
  readonly tableName: string;
  readonly tenantId: string;
  readonly region: string;
  readonly environment: string;
}

/**
 * Everything read from the environment, in one place taking `env` as an
 * argument so both sides of each fallback are testable — the trap that broke
 * main twice, and the reason `handlerConfig` exists in transform-handler.ts.
 */
export function reconcileConfig(env: NodeJS.ProcessEnv): ReconcileConfig {
  return {
    tableName: env["TABLE_NAME"] ?? "",
    tenantId: env["TENANT_ID"] ?? "frost",
    region: env["AWS_REGION"] ?? "eu-west-1",
    environment: env["ENVIRONMENT"] ?? "dev",
  };
}

/**
 * Group a scan into what the reconciliation needs.
 *
 * One scan rather than a query per account per kind: this ledger is small
 * enough that the extra calls would buy nothing, and a single consistent read
 * avoids reconciling one account's balances against another's transactions.
 */
export function groupForReconciliation(rows: readonly Row[]): {
  accounts: ReconcilableAccount[];
  readings: Map<string, Reading[]>;
  // Typed as `ReconciliationMovement`, which carries `firstSeenAt`. The previous declaration
  // listed only timestamp and amount while the literal below spread the third
  // field in conditionally: it flowed at runtime and was invisible to the type
  // system, so dropping the field that distinguishes a late settler from a
  // missing transaction would have compiled cleanly.
  movements: Map<string, ReconciliationMovement[]>;
} {
  const by = <T>(kind: string, pick: (r: Row) => T): Map<string, T[]> => {
    const out = new Map<string, T[]>();
    for (const r of rows) {
      if (rowKind(r) !== kind) continue;
      const id = String(r["accountId"]);
      out.set(id, [...(out.get(id) ?? []), pick(r)]);
    }
    return out;
  };

  return {
    accounts: rows
      .filter((r) => rowKind(r) === "account")
      .map((r) => ({ accountId: String(r["accountId"]), isCard: r["isCard"] === true })),
    readings: by("balanceReading", (r) => ({
      accountId: String(r["accountId"]),
      asOf: String(r["asOf"]),
      fetchedAt: String(r["fetchedAt"]),
      balance: Number(r["balance"]),
    })),
    movements: by("transaction", (r) => ({
      timestamp: String(r["timestamp"]),
      amount: Number(r["amount"]),
      // Write-once since provenance stopped being overwritten, so this is when
      // the row first appeared rather than when it was last touched. Absent on
      // rows written before that, and read as "we already had it".
      ...(typeof r["ingestedAt"] === "string" ? { firstSeenAt: r["ingestedAt"] } : {}),
    })),
  };
}

/**
 * Serve the reconciliation's reads from one scan.
 *
 * Separate from the entry point so the wiring is testable: reading an account's
 * readings against another account's transactions would produce a confident
 * wrong answer, and nothing about the use case itself could catch it.
 */
export function dataFrom(rows: readonly Row[]): ReconciliationData {
  const { accounts, readings, movements } = groupForReconciliation(rows);
  return {
    accounts: async () => accounts,
    readings: async (id) => readings.get(id) ?? [],
    movements: async (id) => movements.get(id) ?? [],
  };
}

/**
 * Read the table, reconcile it, and report what was found.
 *
 * Takes its clients as arguments so this is testable against fakes — the entry
 * point below is the only place that constructs real ones.
 */
export async function reconcileFrom(
  tableRows: TableRows,
  ledger: ReconciliationMarks,
  config: ReconcileConfig,
  write?: (line: string) => void,
): Promise<ReconciliationReport> {
  const rows = [...(await scanAll(tableRows))];
  const result = await reconcile({ data: dataFrom(rows), marks: ledger }, config.tenantId);

  // The per-account lines come back rather than being written from inside the
  // domain, so this is where they reach a log.
  for (const line of result.lines) (write ?? console.log)(line);

  emit(
    {
      namespace: "Tightarse",
      // The deployment, not the TrueLayer environment. A metric emitted under
      // "live" is invisible to an alarm watching "dev", which is #31.
      environment: config.environment,
      metrics: result.metrics,
      properties: { tenantId: config.tenantId },
    },
    ...(write ? [write] : []),
  );

  return result;
}
