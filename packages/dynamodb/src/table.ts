/**
 * The table, and the three things every adapter over it needs.
 *
 * A shared base rather than a shared instance, because the adapters are
 * constructed independently — a component that needs `DynamoTransactions` should
 * not have to build a store that also knows about members.
 *
 * Everything here is mechanical: paging a query, batching a write, retrying what
 * DynamoDB declines to process. No decisions, which is why it can be shared
 * without smuggling policy between concerns.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";

const BATCH_SIZE = 25; // DynamoDB's BatchWriteItem limit

/**
 * How many conditional writes to have in flight at once.
 *
 * `upsertPreserving` cannot batch — an update expression is one item per call —
 * so a replay of a large account is thousands of calls. Unbounded concurrency
 * throttles the table; one at a time takes minutes. This is the ordinary
 * daily path at tens of items, where it makes no difference either way.
 */
const WRITE_CONCURRENCY = 25;

export interface TableOptions {
  readonly tableName: string;
  readonly client?: DynamoDBDocumentClient;
  readonly region?: string;
  readonly endpoint?: string;
}

export abstract class TableAdapter {
  protected readonly doc: DynamoDBDocumentClient;
  protected readonly table: string;

  constructor(opts: TableOptions) {
    this.table = opts.tableName;
    this.doc =
      opts.client ??
      DynamoDBDocumentClient.from(
        new DynamoDBClient({
          ...(opts.region ? { region: opts.region } : {}),
          ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
        }),
        // Optional schema fields are simply absent rather than null, so an
        // undefined merchantName does not become an attribute.
        { marshallOptions: { removeUndefinedValues: true } },
      );
  }

  protected async queryByPrefix(tenantId: string, prefix: string): Promise<Record<string, unknown>[]> {
    return this.queryAll({
      TableName: this.table,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
      ExpressionAttributeValues: { ":pk": `T#${tenantId}`, ":sk": prefix },
    });
  }

  /** Query every page. Callers deal in complete result sets at this volume. */
  protected async queryAll(input: QueryCommandInput): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(
        new QueryCommand({ ...input, ...(start ? { ExclusiveStartKey: start } : {}) }),
      );
      out.push(...((res.Items ?? []) as Record<string, unknown>[]));
      start = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (start);
    return out;
  }

  /**
   * Batch write with retry.
   *
   * BatchWriteItem can return UnprocessedItems on throttling without failing, so
   * ignoring the response silently drops rows — the kind of data loss that shows
   * up months later as a missing transaction.
   */
  protected async batchWrite(requests: readonly Record<string, unknown>[]): Promise<void> {
    for (let i = 0; i < requests.length; i += BATCH_SIZE) {
      let batch = requests.slice(i, i + BATCH_SIZE);
      for (let attempt = 0; batch.length > 0; attempt += 1) {
        if (attempt > 8) {
          throw new Error(`BatchWrite still had ${batch.length} unprocessed items after ${attempt} attempts`);
        }
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 50, 2000)));
        }
        const res = await this.doc.send(
          new BatchWriteCommand({ RequestItems: { [this.table]: batch as never } }),
        );
        batch = (res.UnprocessedItems?.[this.table] ?? []) as typeof batch;
      }
    }
  }

  /**
   * Upsert an item, leaving named attributes alone if the row already exists.
   *
   * A plain put replaces the whole row, so any attribute recording *when we
   * wrote* rather than *what the row says* changes on every write. That is not
   * idempotent, and it has cost this repository three times: a backlog marker
   * that re-queued categorised transactions on replay, 9,790 phantom differences
   * on the first replay comparison, and a reconciliation that could not tell when
   * a transaction entered a balance because `ingestedAt` meant "last written".
   *
   * `preserve` names the attributes describing the FIRST observation. They are
   * written when the row is new and never touched again, so replaying the raw
   * zone converges on identical rows rather than merely on the same keys.
   */
  protected async upsertPreserving(
    items: readonly Record<string, unknown>[],
    preserve: readonly string[],
  ): Promise<void> {
    const write = async (item: Record<string, unknown>): Promise<void> => {
      const { pk, sk, ...rest } = item;
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      const sets: string[] = [];
      let n = 0;
      for (const [attr, value] of Object.entries(rest)) {
        if (value === undefined) continue;
        const nk = `#a${n}`;
        const vk = `:v${n}`;
        n += 1;
        names[nk] = attr;
        values[vk] = value;
        // if_not_exists keeps the first observation. Everything else is the
        // transaction itself and is safe to overwrite with an identical value.
        sets.push(preserve.includes(attr) ? `${nk} = if_not_exists(${nk}, ${vk})` : `${nk} = ${vk}`);
      }
      if (sets.length === 0) return;
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk, sk },
          UpdateExpression: `SET ${sets.join(", ")}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
    };

    for (let i = 0; i < items.length; i += WRITE_CONCURRENCY) {
      await Promise.all(items.slice(i, i + WRITE_CONCURRENCY).map(write));
    }
  }
}
