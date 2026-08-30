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

import { emit } from "@tightarse/metrics";
import { rowKind, scanAll, type Row } from "@tightarse/domain";
import { reconcile } from "@tightarse/domain";
import type {
  AccountId,
  ReconciliationMovement,
  Reading,
  ReconciliationData,
  ReconciliationMarks,
  ReconciliationReport,
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
  accounts: Array<{ accountId: AccountId; isCard: boolean }>;
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
    accounts: async () => accounts.map((a) => a.accountId),
    readings: async (id) => readings.get(id) ?? [],
    movements: async (id) => movements.get(id) ?? [],
  };
}

/**
 * Counts to emit, split by card because cards cannot be compared to accounts.
 *
 * Here rather than in the domain because these are CloudWatch metric names, and
 * an alarm matches them by exact spelling. The split itself is the domain's
 * decision — the report carries per-account results — but what the numbers are
 * called is this layer's business, and only this layer knows which accounts are
 * cards.
 */
export function reconciliationMetrics(
  report: ReconciliationReport,
  isCard: (accountId: AccountId) => boolean,
): Record<string, number> {
  const sum = (want: boolean, pick: (a: { checked: number; breaks: number }) => number) =>
    Object.entries(report.accounts)
      .filter(([id]) => isCard(id) === want)
      .reduce((total, [, a]) => total + pick(a), 0);

  return {
    // Split because a single total would say something is wrong without saying
    // where, and because an alarm that cannot tell a card from an account is
    // how the permanently-firing alarm in 927c593 happened.
    ReconciliationBreaksAccount: sum(false, (a) => a.breaks),
    ReconciliationBreaksCard: sum(true, (a) => a.breaks),
    // Emitted so zero checks is distinguishable from zero breaks. An account
    // with one reading has nothing to check yet, and that must not read as
    // healthy.
    ReconciliationsChecked: report.checked,
  };
}

/**
 * One JSON object per account, for a log.
 *
 * Counts only. An amount here would be a balance, and a balance is as personal
 * as a transaction. Formatting lives here because a serialised log line is not a
 * domain concept — the report carries the facts and this decides how they read.
 */
export function reconciliationLines(
  report: ReconciliationReport,
  isCard: (accountId: AccountId) => boolean,
): string[] {
  return Object.entries(report.accounts).map(([accountId, a]) =>
    JSON.stringify({ accountId, isCard: isCard(accountId), ...a }),
  );
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
  const cards = new Set(groupForReconciliation(rows).accounts.filter((a) => a.isCard).map((a) => a.accountId));
  const isCard = (id: AccountId) => cards.has(id);

  const result = await reconcile({ data: dataFrom(rows), marks: ledger }, config.tenantId);

  // Naming and formatting are this layer's, so both happen here rather than
  // arriving pre-rendered from the domain.
  for (const line of reconciliationLines(result, isCard)) (write ?? console.log)(line);

  emit(
    {
      namespace: "Tightarse",
      // The deployment, not the TrueLayer environment. A metric emitted under
      // "live" is invisible to an alarm watching "dev", which is #31.
      environment: config.environment,
      metrics: reconciliationMetrics(result, isCard),
      properties: { tenantId: config.tenantId },
    },
    ...(write ? [write] : []),
  );

  return result;
}
