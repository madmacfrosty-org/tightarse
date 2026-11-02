import { DynamoStore, DynamoTableRows } from "@tightarse/dynamodb";
import { reconcileConfig, reconcileFrom, recordRenamesFrom } from "@tightarse/domain";
import type { RenameDeps, ReconciliationMarks, TableRows } from "@tightarse/domain";

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
 *
 * It now does two things, because both need the same settled ledger and the
 * same daily cadence: it checks the transactions against the balances the
 * banks reported, and it records any account the provider has renamed (#199).
 * They are independent — neither reads what the other writes — so the only
 * thing the order decides is which one a failure in the other can prevent.
 */
export interface ReconcileDeps {
  readonly rows: TableRows;
  // The port, not the adapter: this hands its store straight to
  // `reconcileFrom`, which needs two methods. Typing it concretely made a
  // Lambda that only marks readings dirty capable of writing transactions.
  readonly ledger: ReconciliationMarks;
  /**
   * Separately typed, and deliberately not folded into `ledger` above.
   *
   * Recording a rename decides which transactions belong to which account.
   * Marking a balance reading dirty does not. One store satisfies both, and
   * the ports stay apart so that is the store's business rather than a
   * capability this handler hands out twice.
   */
  readonly renames: RenameDeps["ledger"];
  readonly config: ReturnType<typeof reconcileConfig>;
}

/** Built by the entry point below, and by nothing a test runs. */
export function realDeps(): ReconcileDeps {
  const config = reconcileConfig(process.env);
  // One store, two ports. A warm container should not hold two clients.
  const store = new DynamoStore({
    tableName: config.tableName,
    region: config.region,
  });
  return {
    config,
    rows: new DynamoTableRows({ tableName: config.tableName, region: config.region }),
    ledger: store,
    renames: store,
  };
}

/**
 * Memoised, so a warm container reuses the connection pool — the same reason
 * the other handlers in this service build once.
 */
let cached: ReconcileDeps | undefined;

export async function handler(): Promise<unknown> {
  cached ??= realDeps();
  // Balance reconciliation first. It is the established check and the one an
  // alarm already watches, so a failure in the newer step must not be what
  // stops it running. Renames are recorded after, and left to throw: a
  // household whose figures are wrong for another day is a better outcome
  // than a handler that reports success while recording nothing.
  const reconciliation = await reconcileFrom(
    cached.rows,
    cached.ledger,
    cached.config,
  );
  const renames = await recordRenamesFrom({ ledger: cached.renames }, cached.config);
  return { reconciliation, renames };
}
