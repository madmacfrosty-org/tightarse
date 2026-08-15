import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Ledger } from "@tightarse/ledger";
import { reconcileConfig, reconcileFrom } from "@tightarse/transform";

/**
 * Scheduled reconciliation, wired up.
 *
 * Here rather than in `@tightarse/transform` because this is where every Lambda
 * entry point in this repository lives — the packages hold logic and the
 * services hold the wiring that constructs clients for it.
 *
 * Runs after the sync and after the categoriser, so it sees a settled ledger.
 * The work is in `reconcileFrom`, which takes its clients as arguments.
 */
export interface ReconcileDeps {
  readonly doc: DynamoDBDocumentClient;
  readonly ledger: Ledger;
  readonly config: ReturnType<typeof reconcileConfig>;
}

/** Built by the entry point below, and by nothing a test runs. */
export function realDeps(): ReconcileDeps {
  const config = reconcileConfig(process.env);
  return {
    config,
    doc: DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region })),
    ledger: new Ledger({ tableName: config.tableName, region: config.region }),
  };
}

/**
 * Memoised, so a warm container reuses the connection pool — the same reason
 * the other handlers in this service build once.
 */
let cached: ReconcileDeps | undefined;

export async function handler(): Promise<unknown> {
  cached ??= realDeps();
  return reconcileFrom(cached.doc, cached.ledger, cached.config);
}
