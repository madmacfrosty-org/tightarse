import { DynamoStore, DynamoTableRows } from "@tightarse/dynamodb";
import { reconcileConfig, reconcileFrom } from "./reconcile-job.js";
import type { ReconciliationMarks, TableRows } from "@tightarse/ports";

/**
 * Scheduled reconciliation, wired up.
 *
 * Beside the logic it drives. It used to live in `services/ingest` on the rule
 * that every Lambda entry point belonged there, which made ingest depend on
 * transform — one driving adapter importing another, for no reason but where a
 * file sat. Grouping in a CloudFormation stack is a deployment choice and says
 * nothing about which code may import which.
 *
 * Runs after the sync and after the categoriser, so it sees a settled ledger.
 * The work is in `reconcileFrom`, which takes its clients as arguments.
 */
export interface ReconcileDeps {
  readonly rows: TableRows;
  // The port, not the adapter: this hands its store straight to
  // `reconcileFrom`, which needs two methods. Typing it concretely made a
  // Lambda that only marks readings dirty capable of writing transactions.
  readonly ledger: ReconciliationMarks;
  readonly config: ReturnType<typeof reconcileConfig>;
}

/** Built by the entry point below, and by nothing a test runs. */
export function realDeps(): ReconcileDeps {
  const config = reconcileConfig(process.env);
  return {
    config,
    rows: new DynamoTableRows({ tableName: config.tableName, region: config.region }),
    ledger: new DynamoStore({ tableName: config.tableName, region: config.region }),
  };
}

/**
 * Memoised, so a warm container reuses the connection pool — the same reason
 * the other handlers in this service build once.
 */
let cached: ReconcileDeps | undefined;

export async function handler(): Promise<unknown> {
  cached ??= realDeps();
  return reconcileFrom(cached.rows, cached.ledger, cached.config);
}
