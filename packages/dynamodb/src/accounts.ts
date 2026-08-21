/**
 * Accounts and their balances.
 *
 * `putBalances` writes only the fields it was given. An earlier version wrote a
 * whole placeholder account, and its "unknown" institution then overwrote real
 * details fetched moments earlier.
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

/** The DynamoDB adapter for the `Accounts` port. */
export class DynamoAccounts extends TableAdapter implements Accounts {
  async listAccounts(tenantId: string): Promise<Record<string, unknown>[]> {
    return this.queryByPrefix(tenantId, "ACCOUNT#");
  }

  /**
   * Upsert an account, MERGING rather than replacing.
   *
   * A plain put loses data depending on processing order. Account details and
   * balances arrive on different endpoints, so a later `/accounts` list object
   * would overwrite a balance written moments earlier by `/balance` — which is
   * exactly what happened to the card, whose dataset name sorts after its
   * balance. Regular accounts survived only by the accident of `balance`
   * sorting last, and under S3 events, where order is arbitrary, they would be
   * just as exposed.
   *
   * Balances are therefore only written when supplied, and never cleared.
   */
  async putAccount(a: Account, balances: { current?: number; available?: number } = {}): Promise<void> {
    const item = accountItem(a, balances);
    const { pk, sk, ...attributes } = item as Record<string, unknown> & { pk: string; sk: string };

    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const sets: string[] = [];
    let i = 0;
    for (const [key, value] of Object.entries(attributes)) {
      if (value === undefined) continue;
      const n = `#n${i}`;
      const v = `:v${i}`;
      names[n] = key;
      values[v] = value;
      sets.push(`${n} = ${v}`);
      i += 1;
    }

    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk, sk },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  }

  /**
   * Write balances only, touching nothing else on the account row.
   *
   * Balances arrive on their own endpoint, so a row may not exist yet. The
   * previous approach upserted a whole minimal Account here — and its
   * placeholder values then overwrote real details fetched moments earlier,
   * which is why every current account read "institutionName: unknown".
   */
  async putBalances(
    tenantId: string,
    accountId: string,
    balances: { current?: number; available?: number; currency?: string; isCard?: boolean },
  ): Promise<void> {
    const { pk, sk } = keys.account(tenantId, accountId);
    const sets: string[] = ["#kind = :kind", "#tenantId = :tenantId", "#accountId = :accountId"];
    const names: Record<string, string> = {
      "#kind": "kind",
      "#tenantId": "tenantId",
      "#accountId": "accountId",
    };
    const values: Record<string, unknown> = {
      ":kind": "ACCOUNT",
      ":tenantId": tenantId,
      ":accountId": accountId,
    };
    const maybe = (key: string, value: unknown) => {
      if (value === undefined) return;
      names[`#${key}`] = key;
      values[`:${key}`] = value;
      sets.push(`#${key} = :${key}`);
    };
    maybe("currentBalance", balances.current);
    maybe("availableBalance", balances.available);
    maybe("currency", balances.currency);
    // Written here as well as on the accounts path, because it is the one field
    // whose absence makes a balance unreadable: it says whether the figure is
    // money held or money owed (#29). It is not a placeholder — the caller
    // derives it from which endpoint returned the data, exactly as the accounts
    // path does, so a row created here carries a real answer rather than a
    // guess that later has to be overwritten.
    maybe("isCard", balances.isCard);

    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk, sk },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  }
}
