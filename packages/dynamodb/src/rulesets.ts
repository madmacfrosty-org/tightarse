/**
 * Rule sets. Authored, versioned, and never regenerated.
 *
 * A published version is immutable, enforced by a condition rather than by
 * discipline: a categorisation's provenance names a set version, and rewriting
 * that version would change what the provenance means after the fact.
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
  type Category,
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
  Categories,
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

/** The DynamoDB adapter for the `RuleSets` port. */
/**
 * The category catalogue.
 *
 * Overwritten in place rather than versioned: a label, a colour and a
 * description are presentation and change freely. What must not change is the
 * id, and nothing here can change one — a different id is a different category.
 */
export class DynamoCategories extends TableAdapter implements Categories {
  async putCategory(tenantId: string, category: Category): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        // No `kind` marker, unlike every other item here. A category HAS a
        // `kind` — spending, income or movement — and a marker of that name
        // silently overwrote it, turning every category into kind "CATEGORY".
        // Nothing needs the marker: rows in the tenant partition are found by
        // their sort-key prefix, and `kind` identifies rows only inside a
        // transaction's partition, where categories never live.
        Item: { ...keys.category(tenantId, category.id), ...category, tenantId },
      }),
    );
  }

  async listCategories(tenantId: string): Promise<Record<string, unknown>[]> {
    return this.queryByPrefix(tenantId, "CATEGORY#");
  }
}

export class DynamoRuleSets extends TableAdapter implements RuleSets {
  /**
   * The current version of every rule set, and nothing else.
   *
   * The prefix is deliberately disjoint from where versions live, so this — the
   * read every fold run makes — never grows as history accumulates.
   *
   * The caller orders by `order`; precedence is data, not the order rows arrive.
   */
  async listRuleSets(tenantId: string): Promise<Record<string, unknown>[]> {
    return this.queryByPrefix(tenantId, "RULESET#");
  }

  /**
   * Every version of one rule set, oldest first.
   *
   * Kept rather than pruned: a categorisation records the set version that
   * produced it, so "what did this rule say when it fired?" needs the version it
   * names to still exist.
   */
  async listRuleSetHistory(tenantId: string, setId: string): Promise<Record<string, unknown>[]> {
    return this.queryAll({
      TableName: this.table,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
      ExpressionAttributeValues: {
        ":pk": keys.ruleSetVersion(tenantId, setId, 0).pk,
        ":sk": `${setId}#`,
      },
    });
  }

  /**
   * Publish a rule set version: the immutable record and the current pointer,
   * written together.
   *
   * One transaction, because the current row is a copy. If only one landed they
   * would disagree about what the current version is, and every skip decision
   * downstream reads the copy — so a fold run would silently use the wrong rules
   * and write categorisations attributing them to a version that says something
   * else.
   */
  async putRuleSetVersion(tenantId: string, set: RuleSet): Promise<void> {
    const { current, version } = ruleSetItems(tenantId, set);
    await this.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: this.table, Item: current } },
          {
            Put: {
              TableName: this.table,
              Item: version,
              // A published version is immutable. Rewriting one would change
              // what a categorisation's provenance means after the fact.
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ],
      }),
    );
  }

  /**
   * A household's own categorisation rules.
   *
   * One row holding the list: there are tens of these, not thousands, and the
   * categoriser wants all of them on every run. A row each would turn one Get
   * into a Query for no benefit.
   */
  async getCustomRules(tenantId: string): Promise<CustomRule[]> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: keys.customRules(tenantId) }),
    );
    return ((res.Item as { rules?: CustomRule[] } | undefined)?.rules ?? []) as CustomRule[];
  }

  async putCustomRules(tenantId: string, rules: readonly CustomRule[]): Promise<void> {
    const { pk, sk } = keys.customRules(tenantId);
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { pk, sk, kind: "RULES", tenantId, rules, updatedAt: new Date().toISOString() },
      }),
    );
  }
}
