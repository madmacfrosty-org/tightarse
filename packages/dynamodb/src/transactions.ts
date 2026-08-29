/**
 * The transaction record.
 *
 * `listRange` returns three row kinds from one query because they share a
 * partition and sort adjacently within a timestamp. That adjacency is the whole
 * reason the keys look the way they do, and it is what makes a batch read one
 * call rather than three.
 */

import {
  Categorisation,
  RecordedTransaction,
  type Transaction,
} from "@tightarse/domain";
import { keys, RowKind } from "./keys.js";
import type { DateRange, Transactions } from "@tightarse/domain";
import { pendingItem, transactionItem } from "./items.js";
import { parseFacts } from "./parse.js";
import { TableAdapter } from "./table.js";

/**
 * Attributes describing the first time we saw a row, not its content.
 *
 * Written once and never overwritten, so a row is a function of the transaction
 * and a replay is byte-identical. `ingestedAt` then genuinely means "first seen",
 * which is what the reconciliation needs to tell when a transaction entered a
 * balance.
 */
const FIRST_OBSERVATION = ["ingestedAt", "sourceObject"] as const;

/**
 * A pending row expires on its own.
 *
 * Pending is a cache, not a ledger entry — a pending transaction changes amount
 * and can vanish entirely. A week is long enough that a settled row has replaced
 * it and short enough that a stale one cannot linger unnoticed.
 */
const PENDING_TTL_SECONDS = 7 * 24 * 60 * 60;

/** The DynamoDB adapter for the `Transactions` port. */
export class DynamoTransactions extends TableAdapter implements Transactions {
  /**
   * Transactions and their categorisations for a date range, in one query.
   *
   * This is the dashboard's primary read. The row kind sits after the timestamp
   * in the sort key precisely so a single `between` spans both — an earlier
   * month-partitioned design needed one query per month and could not return
   * categorisations alongside without a second pass.
   */
  async listRange(
    tenantId: string,
    range: DateRange,
  ): Promise<{
    transactions: RecordedTransaction[];
    categorisations: Categorisation[];
  }> {
    const rows = await this.queryAll({
      TableName: this.table,
      KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
      ExpressionAttributeValues: {
        ":pk": keys.transaction(tenantId, range.from, "").pk,
        ":from": range.from,
        // "￿" sorts above any character the sort key can contain, making
        // the upper bound exclusive of `to` itself but inclusive of everything
        // stamped within the preceding instant.
        ":to": `${range.to}￿`,
      },
    });

    return {
      transactions: parseFacts(
        RecordedTransaction,
        rows.filter((r) => r["kind"] === RowKind.transaction),
        "transaction",
      ),
      // Free: categorisations sort into the same partition between the same
      // bounds, so a batch of transactions arrives with its categorisations
      // already attached. This is what makes batch processing one read.
      categorisations: parseFacts(
        Categorisation,
        rows.filter((r) => r["kind"] === RowKind.categorisation),
        "categorisation",
      ),
    };
  }

  /** Per-account history, via gsi1. */
  async listAccountRange(
    tenantId: string,
    accountId: string,
    range: DateRange,
  ): Promise<RecordedTransaction[]> {
    const rows = await this.queryAll({
      TableName: this.table,
      IndexName: "gsi1-account",
      KeyConditionExpression: "gsi1pk = :pk AND gsi1sk BETWEEN :from AND :to",
      ExpressionAttributeValues: {
        ":pk": keys.accountIndex(tenantId, accountId, range.from, "").gsi1pk,
        ":from": range.from,
        ":to": `${range.to}￿`,
      },
    });
    return parseFacts(RecordedTransaction, rows, "transaction");
  }

  /**
   * Upsert settled transactions.
   *
   * No read-before-write. A settled booking date is stable and the sort key
   * embeds the dedup key, so replaying the entire raw landing zone converges on
   * the same rows rather than duplicating them.
   *
   * Converges on the same *content*, not merely the same keys. A plain put
   * replaced the whole row, so `ingestedAt` and `sourceObject` — which describe
   * when we wrote, not what the transaction says — changed on every write. The
   * rolling sync window refetches the last ten days daily, so recent rows were
   * rewritten every morning with new values.
   *
   * That cost three separate things. The first replay comparison reported 9,790
   * differences, all of them write-time attributes. The reconciliation could not
   * tell when a transaction entered a balance, so four Amex transactions that
   * settled after a reading was taken looked like £56.59 of missing money. And an
   * earlier design lost a backlog marker the same way.
   *
   * So provenance is written once and preserved. The cost is that an update
   * expression is one item per call where BatchWriteItem took 25; the daily path
   * is tens of rows, and a full replay is slower in exchange for being
   * reproducible, which is the entire point of a replay.
   */
  async putTransactions(
    txns: readonly Transaction[],
    opts: { sourceObject?: string } = {},
  ): Promise<{ written: number }> {
    const items = txns.map((t) =>
      transactionItem(
        t,
        opts.sourceObject ? { sourceObject: opts.sourceObject } : {},
      ),
    );
    await this.upsertPreserving(items, FIRST_OBSERVATION);
    return { written: items.length };
  }

  async listPending(
    tenantId: string,
    accountId: string,
  ): Promise<Record<string, unknown>[]> {
    return this.queryAll({
      TableName: this.table,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: {
        ":pk": keys.pending(tenantId, accountId, "", "").pk,
      },
    });
  }

  /**
   * Replace the pending set for one account.
   *
   * Delete-and-replace rather than merge: pending transactions change amount,
   * change id on settlement, and disappear without notice. Treating them as a
   * cache is the only honest model.
   */
  async replacePending(
    tenantId: string,
    accountId: string,
    pending: readonly Transaction[],
  ): Promise<{ deleted: number; written: number }> {
    const existing = await this.listPending(tenantId, accountId);
    const deletes = existing.map((row) => ({
      DeleteRequest: { Key: { pk: row["pk"], sk: row["sk"] } },
    }));
    await this.batchWrite(deletes);

    const items = pending.map((t) =>
      pendingItem(t, { ttlSeconds: PENDING_TTL_SECONDS }),
    );
    await this.batchWrite(items.map((Item) => ({ PutRequest: { Item } })));
    return { deleted: deletes.length, written: items.length };
  }
}
