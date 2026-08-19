/**
 * Who may see the household, and how it is configured.
 *
 * Nothing here is derivable from anything else. Losing it means asking a person
 * what they had decided, which is why it is a control-plane port and why a
 * regeneration job holds no interface offering it.
 */

import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  keys,
  RowKind,
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
} from "@tightarse/schema";
import type {
  Accounts,
  Balances,
  Categorisations,
  DateRange,
  Enrichments,
  Household,
  RuleSets,
  Transactions,
} from "@tightarse/ports";
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

/** The DynamoDB adapter for the `Household` port. */
export class DynamoHousehold extends TableAdapter implements Household {
  async getMemberTenant(email: string): Promise<string | null> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: keys.member(email) }),
    );
    const tenantId = (res.Item as { tenantId?: string } | undefined)?.tenantId;
    return tenantId ?? null;
  }

  /** Grant a person access to a household. Administrative action only. */
  async putMember(m: Member): Promise<void> {
    const { pk, sk } = keys.member(m.email);
    await this.doc.send(
      new PutCommand({ TableName: this.table, Item: { pk, sk, kind: "MEMBER", ...m, email: m.email.trim().toLowerCase() } }),
    );
  }

  /**
   * Revoke a person's access.
   *
   * Their claim is baked into any token already issued, so this takes effect
   * when that token expires rather than immediately. Access that cannot be
   * removed at all is the worse problem, but do not mistake this for a kill
   * switch.
   */
  async deleteMember(email: string): Promise<void> {
    await this.doc.send(new DeleteCommand({ TableName: this.table, Key: keys.member(email) }));
  }

  /**
   * Everyone with access to any household.
   *
   * A Scan, deliberately. Member rows sit in their own partitions keyed by
   * email — that is what makes the sign-in lookup a single Get on the hot path
   * — so there is no partition to query them by. An index to serve an
   * administrative command run a handful of times would cost storage on every
   * write forever. Scanning a table this size, for this, is the cheaper trade.
   */
  async listMembers(): Promise<Array<{ email: string; tenantId: string; addedAt?: string }>> {
    const found: Array<{ email: string; tenantId: string; addedAt?: string }> = [];
    let last: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(
        new ScanCommand({
          TableName: this.table,
          FilterExpression: "#kind = :kind",
          ExpressionAttributeNames: { "#kind": "kind" },
          ExpressionAttributeValues: { ":kind": "MEMBER" },
          ...(last ? { ExclusiveStartKey: last } : {}),
        }),
      );
      for (const item of res.Items ?? []) {
        found.push(item as { email: string; tenantId: string; addedAt?: string });
      }
      last = res.LastEvaluatedKey;
    } while (last);
    return found.sort((a, b) => a.email.localeCompare(b.email));
  }

  /**
   * Household settings, or null if never set.
   *
   * Callers must decide their own default rather than getting one here — an
   * implicit default for how data is processed is exactly the kind of thing
   * that should be a visible decision at the call site.
   */
  async getSettings(tenantId: string): Promise<TenantSettings | null> {
    const rows = await this.queryByPrefix(tenantId, "SETTINGS");
    return (rows[0] as TenantSettings | undefined) ?? null;
  }

  async putSettings(s: TenantSettings): Promise<void> {
    const { pk, sk } = keys.settings(s.tenantId);
    await this.doc.send(
      new PutCommand({ TableName: this.table, Item: { pk, sk, kind: "SETTINGS", ...s } }),
    );
  }

  async listConsents(tenantId: string): Promise<Record<string, unknown>[]> {
    return this.queryByPrefix(tenantId, "CONSENT#");
  }

  async putConsent(c: Consent): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: consentItem(c) }));
  }
}
