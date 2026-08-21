/**
 * Enrichment, as it exists today.
 *
 * `listToEnrich` defines the backlog as "has no enrichment row" — a business
 * rule living in the persistence layer, which the categorisation design replaces
 * with staleness by rule set version. Kept in its own adapter so what is going
 * away is visible rather than buried among thirty methods.
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
import { TableAdapter, type TableOptions } from "./table.js";

/**
 * The DynamoDB adapter for the `Enrichments` port.
 *
 * It depends on `Transactions`, which the single class hid: the backlog is
 * computed by diffing transactions against enrichments, so working out what
 * needs categorising means reading the transactions. Taking the port rather than
 * the sibling adapter keeps the direction right and makes the dependency
 * something a reader can see.
 */
export class DynamoEnrichments extends TableAdapter implements Enrichments {
  private readonly transactions: Transactions;

  constructor(opts: TableOptions & { transactions: Transactions }) {
    super(opts);
    this.transactions = opts.transactions;
  }

  /**
   * Transactions in a range with no enrichment yet — the categoriser's backlog.
   *
   * Derived rather than indexed. A sparse index needed a marker on the
   * transaction row, and a plain put replaces the whole row, so replaying a raw
   * object re-queued work that was already done. Since replay is the point of
   * the landing zone, that failure was routine rather than exotic.
   *
   * The range query already returns both kinds, so the diff is free beyond the
   * rows themselves.
   */
  async listToEnrich(
    tenantId: string,
    range: DateRange,
    limit?: number,
  ): Promise<Record<string, unknown>[]> {
    const { transactions, enrichments } = await this.transactions.listRange(tenantId, range);
    const enriched = new Set(enrichments.map((e) => String(e["dedupKey"])));
    const outstanding = transactions.filter((t) => !enriched.has(String(t["dedupKey"])));
    return limit === undefined ? outstanding : outstanding.slice(0, limit);
  }

  /**
   * Store an enrichment.
   *
   * A plain put on a deterministic key, so re-running the categoriser over the
   * same transaction converges rather than duplicating. Nothing on the
   * transaction row is touched — the ledger stays deterministic and agents only
   * ever add rows beside it.
   *
   * The condition guards against enriching a transaction that is not there,
   * which would leave a row describing nothing.
   */
  async putEnrichment(e: TransactionEnrichment): Promise<void> {
    const txnKey = keys.transaction(e.tenantId, e.timestamp, e.dedupKey);
    await this.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: this.table, Item: enrichmentItem(e) } },
          {
            ConditionCheck: {
              TableName: this.table,
              Key: txnKey,
              ConditionExpression: "attribute_exists(pk)",
            },
          },
        ],
      }),
    );
  }

  /**
   * Delete every enrichment in a range produced by one source.
   *
   * This is what the `producedBy` provenance is for: a bad rule version or a
   * superseded model can be invalidated wholesale, and the affected
   * transactions return to the backlog automatically because the backlog is
   * derived from the absence of an enrichment.
   */
  async deleteEnrichments(
    tenantId: string,
    range: DateRange,
    producedBy: string,
  ): Promise<{ deleted: number }> {
    const { enrichments } = await this.transactions.listRange(tenantId, range);
    const doomed = enrichments.filter((e) => e["producedBy"] === producedBy);
    await this.batchWrite(
      doomed.map((e) => ({ DeleteRequest: { Key: { pk: e["pk"], sk: e["sk"] } } })),
    );
    return { deleted: doomed.length };
  }
}
