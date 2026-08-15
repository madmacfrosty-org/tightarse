/**
 * Reconciliation: does the ledger's arithmetic agree with the bank's?
 *
 * Run on a schedule rather than as part of the transform, because the transform
 * runs once per raw object with no ordering between them — a balance reading and the
 * transactions it should be checked against arrive as separate S3 events, in
 * whatever order Lambda schedules them. Checking at write time would compare
 * against whatever had happened to land.
 *
 * Runs after the sync and after the categoriser, so it sees a settled ledger.
 */

import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Ledger } from "@tightarse/ledger";
import { emit } from "@tightarse/metrics";
import { runReconciliation, type ReconcilePhaseDeps, type ReconcilePhaseResult } from "./reconcile-phase.js";
import { rowKind, scanAll, type Row } from "./compare.js";

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
  accounts: Array<{ accountId: string; isCard: boolean }>;
  readings: Map<string, Array<{ accountId: string; asOf: string; fetchedAt: string; balance: number }>>;
  movements: Map<string, Array<{ timestamp: string; amount: number }>>;
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
    })),
  };
}

/**
 * Turn a scan and a ledger into the phase's dependencies.
 *
 * Separate from the entry point so the wiring is testable: reading an account's
 * readings against another account's transactions would produce a confident
 * wrong answer, and nothing about the phase itself would catch it.
 */
export function phaseDepsFrom(
  rows: readonly Row[],
  ledger: Pick<Ledger, "markBalanceReadingDirty" | "clearBalanceReadingDirty">,
  tenantId: string,
): ReconcilePhaseDeps {
  const { accounts, readings, movements } = groupForReconciliation(rows);
  return {
    accounts: async () => accounts,
    readings: async (id) => readings.get(id) ?? [],
    movements: async (id) => movements.get(id) ?? [],
    markDirty: (id, asOf, fetchedAt, discrepancy) =>
      ledger.markBalanceReadingDirty(tenantId, id, asOf, fetchedAt, discrepancy),
    clearDirty: (id, asOf, fetchedAt) => ledger.clearBalanceReadingDirty(tenantId, id, asOf, fetchedAt),
  };
}

/**
 * Read the table, reconcile it, and report what was found.
 *
 * Takes its clients as arguments so this is testable against fakes — the entry
 * point below is the only place that constructs real ones.
 */
export async function reconcileFrom(
  doc: DynamoDBDocumentClient,
  ledger: Pick<Ledger, "markBalanceReadingDirty" | "clearBalanceReadingDirty">,
  config: ReconcileConfig,
  write?: (line: string) => void,
): Promise<ReconcilePhaseResult> {
  const rows = await scanAll(doc, config.tableName);
  const result = await runReconciliation({
    ...phaseDepsFrom(rows, ledger, config.tenantId),
    ...(write ? { log: write } : {}),
  });

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
