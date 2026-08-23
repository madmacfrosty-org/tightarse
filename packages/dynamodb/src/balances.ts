/**
 * Balance readings, and the marks reconciliation leaves on them.
 *
 * Every reading is kept rather than only the latest, because reconciliation needs
 * two readings and the transactions between them — the only check that covers
 * cards, which carry no running balance at all.
 */

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  type Account,
  type BalanceReading,
  type Categorisation,
  type Consent,
  type CustomRule,
  type Member,
  type RuleSet,
  type TenantSettings,
  type Transaction,
} from "@tightarse/domain";
import { keys, RowKind } from "./keys.js";
import type {
  Accounts,
  Balances,
  Categorisations,
  DateRange,
  Household,
  RuleSets,
  Transactions,
} from "@tightarse/domain";
import {
  accountItem,
  categorisationItems,
  consentItem,
  pendingItem,
  ruleSetItems,
  transactionItem,
} from "./items.js";
import { TableAdapter } from "./table.js";

/** The DynamoDB adapter for the `Balances` port. */
export class DynamoBalances extends TableAdapter implements Balances {
  /**
   * Record one balance reading, keeping every previous one.
   *
   * A plain put keyed by fetch time, so re-transforming the same raw object
   * converges rather than duplicating — the same property the rest of the
   * transform relies on, and what lets a replay rebuild the whole series.
   */
  async putBalanceReading(reading: BalanceReading): Promise<void> {
    const { pk, sk } = keys.balanceReading(reading.tenantId, reading.accountId, reading.asOf, reading.fetchedAt);
    await this.doc.send(
      new PutCommand({ TableName: this.table, Item: { pk, sk, kind: "BALANCE", ...reading } }),
    );
  }

  /** Every balance reading for an account, ordered by when the balance was true. */
  async listBalanceReadings(tenantId: string, accountId: string): Promise<Record<string, unknown>[]> {
    return this.queryAll({
      TableName: this.table,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": keys.balanceReading(tenantId, accountId, "", "").pk },
    });
  }

  /**
   * Flag a reading whose arithmetic did not work, and by how much.
   *
   * The number is kept and marked rather than hidden or corrected. A synthetic
   * transaction that makes the sum come out right is a healthy-looking figure
   * over missing data; a marked one says what it is.
   */
  async markBalanceReadingDirty(
    tenantId: string,
    accountId: string,
    asOf: string,
    fetchedAt: string,
    discrepancy: number,
  ): Promise<void> {
    const { pk, sk } = keys.balanceReading(tenantId, accountId, asOf, fetchedAt);
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk, sk },
        UpdateExpression: "SET #dirty = :dirty, #discrepancy = :discrepancy",
        ExpressionAttributeNames: { "#dirty": "dirty", "#discrepancy": "discrepancy" },
        ExpressionAttributeValues: { ":dirty": true, ":discrepancy": discrepancy },
        // Only touch a reading that exists. Creating one here would invent a
        // balance out of a failed check.
        ConditionExpression: "attribute_exists(pk)",
      }),
    );
  }

  /**
   * Clear a mark on a reading that now reconciles.
   *
   * The reconciliation recomputes from scratch every run, so a break explained
   * by a late transaction has to be able to stop being one. Without this, marks
   * would only ever accumulate.
   */
  async clearBalanceReadingDirty(
    tenantId: string,
    accountId: string,
    asOf: string,
    fetchedAt: string,
  ): Promise<void> {
    const { pk, sk } = keys.balanceReading(tenantId, accountId, asOf, fetchedAt);
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk, sk },
        UpdateExpression: "REMOVE #dirty, #discrepancy",
        ExpressionAttributeNames: { "#dirty": "dirty", "#discrepancy": "discrepancy" },
        ConditionExpression: "attribute_exists(pk)",
      }),
    );
  }
}
