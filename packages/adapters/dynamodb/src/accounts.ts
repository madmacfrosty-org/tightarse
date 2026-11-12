/**
 * Accounts and their balances.
 *
 * `putBalances` writes only the fields it was given. An earlier version wrote a
 * whole placeholder account, and its "unknown" institution then overwrote real
 * details fetched moments earlier.
 */

import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Account } from "@tightarse/domain";
import { keys } from "./keys.js";
import type { Accounts } from "@tightarse/domain";
import { accountItem } from "./items.js";
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
  async putAccount(
    a: Account,
    balances: { current?: number; available?: number } = {},
  ): Promise<void> {
    const item = accountItem(a, balances);
    const { pk, sk, ...attributes } = item as Record<string, unknown> & {
      pk: string;
      sk: string;
    };

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
    balances: {
      current?: number;
      available?: number;
      currency?: string;
      isCard?: boolean;
    },
  ): Promise<void> {
    const { pk, sk } = keys.account(tenantId, accountId);
    const sets: string[] = [
      "#kind = :kind",
      "#tenantId = :tenantId",
      "#accountId = :accountId",
    ];
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

  /**
   * Record that the provider renamed this account, if it has not been recorded.
   *
   * Conditional on the field's absence, so re-running a sync cannot rewrite a
   * link — and in particular cannot point an account at a second successor
   * because a later sync weighed the evidence differently. The first answer
   * stands until a person removes it, which is the whole reason this is
   * reversible by clearing one field.
   *
   * A row that already carries one is left alone rather than treated as an
   * error: the sync is expected to re-offer what it found last time.
   */
  async markSuperseded(
    tenantId: string,
    accountId: string,
    supersededBy: string,
    reconciledAt: string,
    evidence: { readonly shared: number } | { readonly by: string },
  ): Promise<void> {
    const { pk, sk } = keys.account(tenantId, accountId);
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk, sk },
          // The identity fields too, exactly as `putBalances` does. An update
          // creates the row if it is absent, and one carrying only a link
          // reads back as an account with no id — which every caller then
          // falls back to "" for, so two such rows would look like one
          // account. Writing them costs nothing and the row is always
          // readable.
          // The evidence goes on in the same write, and the other half is
          // REMOVED rather than left: a row that had been matched
          // automatically and is now joined by hand must not keep a count
          // saying a machine decided it.
          UpdateExpression:
            "SET #kind = :kind, #tenantId = :tenantId, #accountId = :accountId, " +
            "#supersededBy = :supersededBy, #reconciledAt = :reconciledAt, " +
            `${"shared" in evidence ? "#reconciledShared = :why" : "#reconciledBy = :why"} ` +
            `REMOVE ${"shared" in evidence ? "#reconciledBy" : "#reconciledShared"}`,
          ConditionExpression: "attribute_not_exists(#supersededBy)",
          ExpressionAttributeNames: {
            "#kind": "kind",
            "#tenantId": "tenantId",
            "#accountId": "accountId",
            "#supersededBy": "supersededBy",
            "#reconciledAt": "reconciledAt",
            "#reconciledShared": "reconciledShared",
            "#reconciledBy": "reconciledBy",
          },
          ExpressionAttributeValues: {
            ":kind": "ACCOUNT",
            ":tenantId": tenantId,
            ":accountId": accountId,
            ":supersededBy": supersededBy,
            ":reconciledAt": reconciledAt,
            ":why": "shared" in evidence ? evidence.shared : evidence.by,
          },
        }),
      );
    } catch (err) {
      if ((err as { name?: string }).name === "ConditionalCheckFailedException") return;
      throw err;
    }
  }

  /**
   * Undo a link, leaving the account row otherwise alone.
   *
   * Unconditional. Clearing a link that is not there is the state being asked
   * for, and failing on it would make an undo button report an error for
   * having nothing to do.
   */
  async clearSuperseded(tenantId: string, accountId: string): Promise<void> {
    const { pk, sk } = keys.account(tenantId, accountId);
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk, sk },
        UpdateExpression:
          "REMOVE #supersededBy, #reconciledAt, #reconciledShared, #reconciledBy",
        ExpressionAttributeNames: {
          "#supersededBy": "supersededBy",
          "#reconciledAt": "reconciledAt",
          "#reconciledShared": "reconciledShared",
          "#reconciledBy": "reconciledBy",
        },
      }),
    );
  }
}
