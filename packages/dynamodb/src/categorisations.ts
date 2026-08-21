/**
 * Categorisations. Current rows arrive via `DynamoTransactions.listRange`; this
 * writes them and reads their history.
 *
 * A write is two rows in one transaction — the version and the current pointer —
 * because the pointer is a copy, and a partial write would leave the two
 * disagreeing about what is in force.
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
  type TransactionEnrichment,
} from "@tightarse/domain";
import { keys, RowKind } from "./keys.js";
import type {
  Accounts,
  Balances,
  Categorisations,
  DateRange,
  Enrichments,
  Household,
  RuleSets,
  Transactions,
} from "@tightarse/domain";
import {
  accountItem,
  categorisationItems,
  consentItem,
  enrichmentItem,
  pendingItem,
  ruleSetItems,
  transactionItem,
} from "./items.js";
import { TableAdapter } from "./table.js";

/** The DynamoDB adapter for the `Categorisations` port. */
export class DynamoCategorisations extends TableAdapter implements Categorisations {
  /**
   * Record a transaction's categorisation from one set: the version and the
   * current pointer, atomically.
   *
   * Same reasoning as rule sets — the current row is a copy, and a partial write
   * would leave the two disagreeing about what is in force.
   */
  async putCategorisation(tenantId: string, c: Categorisation): Promise<void> {
    const { current, version } = categorisationItems(tenantId, c);
    await this.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: this.table, Item: current } },
          {
            Put: {
              TableName: this.table,
              Item: version,
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ],
      }),
    );
  }

  /**
   * Every version of a transaction's categorisations, oldest first per set.
   *
   * Its own partition, so this never enlarges the batch read. Fetched only when
   * somebody asks why a category changed — which is a detail view, not something
   * a list carries.
   */
  async listCategorisationHistory(tenantId: string, dedupKey: string): Promise<Record<string, unknown>[]> {
    return this.queryAll({
      TableName: this.table,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": keys.categorisationVersion(tenantId, dedupKey, "", 0).pk },
    });
  }
}
