import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  BatchWriteCommand,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  TransactWriteCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  keys,
  RowKind,
  type Account,
  type Consent,
  type Transaction,
  type TransactionEnrichment,
  type TenantSettings,
  type Member,
} from "@tightarse/schema";
import { accountItem, consentItem, enrichmentItem, pendingItem, transactionItem } from "./items";

const BATCH_SIZE = 25; // DynamoDB's BatchWriteItem limit
const PENDING_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface LedgerOptions {
  readonly tableName: string;
  /** Supply for tests against DynamoDB Local, or to reuse a warm client. */
  readonly client?: DynamoDBDocumentClient;
  readonly region?: string;
  readonly endpoint?: string;
}

export interface DateRange {
  /** Inclusive ISO-8601 lower bound. */
  readonly from: string;
  /** Exclusive ISO-8601 upper bound. */
  readonly to: string;
}

export class Ledger {
  private readonly doc: DynamoDBDocumentClient;
  private readonly table: string;

  constructor(opts: LedgerOptions) {
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

  // -------------------------------------------------------------- writes

  /**
   * Upsert settled transactions.
   *
   * No read-before-write. A settled booking date is stable and the sort key
   * embeds the dedup key, so a plain put is idempotent — replaying the entire
   * raw landing zone converges on the same rows rather than duplicating them.
   */
  async putTransactions(
    txns: readonly Transaction[],
    opts: { sourceObject?: string } = {},
  ): Promise<{ written: number }> {
    const items = txns.map((t) =>
      transactionItem(t, opts.sourceObject ? { sourceObject: opts.sourceObject } : {}),
    );
    await this.batchWrite(items.map((Item) => ({ PutRequest: { Item } })));
    return { written: items.length };
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

    const items = pending.map((t) => pendingItem(t, { ttlSeconds: PENDING_TTL_SECONDS }));
    await this.batchWrite(items.map((Item) => ({ PutRequest: { Item } })));
    return { deleted: deletes.length, written: items.length };
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

  async putSettings(s: TenantSettings): Promise<void> {
    const { pk, sk } = keys.settings(s.tenantId);
    await this.doc.send(
      new PutCommand({ TableName: this.table, Item: { pk, sk, kind: "SETTINGS", ...s } }),
    );
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

  /** Grant a person access to a household. Administrative action only. */
  async putMember(m: Member): Promise<void> {
    const { pk, sk } = keys.member(m.email);
    await this.doc.send(
      new PutCommand({ TableName: this.table, Item: { pk, sk, kind: "MEMBER", ...m, email: m.email.trim().toLowerCase() } }),
    );
  }

  /**
   * Which household this email belongs to, or null.
   *
   * Null is the safe answer and must stay that way: a caller that invented a
   * default here would hand an unknown identity access to somebody's ledger.
   */
  async getMemberTenant(email: string): Promise<string | null> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: keys.member(email) }),
    );
    const tenantId = (res.Item as { tenantId?: string } | undefined)?.tenantId;
    return tenantId ?? null;
  }

  async putConsent(c: Consent): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: consentItem(c) }));
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
    const { enrichments } = await this.listRange(tenantId, range);
    const doomed = enrichments.filter((e) => e["producedBy"] === producedBy);
    await this.batchWrite(
      doomed.map((e) => ({ DeleteRequest: { Key: { pk: e["pk"], sk: e["sk"] } } })),
    );
    return { deleted: doomed.length };
  }

  // --------------------------------------------------------------- reads

  /**
   * Transactions and their enrichments for a date range, in one query.
   *
   * This is the dashboard's primary read. The row kind sits after the timestamp
   * in the sort key precisely so a single `between` spans both — an earlier
   * month-partitioned design needed one query per month and could not return
   * enrichments alongside without a second pass.
   */
  async listRange(
    tenantId: string,
    range: DateRange,
  ): Promise<{ transactions: Record<string, unknown>[]; enrichments: Record<string, unknown>[] }> {
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
      transactions: rows.filter((r) => r["kind"] === RowKind.transaction),
      enrichments: rows.filter((r) => r["kind"] === RowKind.enrichment),
    };
  }

  /** Per-account history, via gsi1. */
  async listAccountRange(
    tenantId: string,
    accountId: string,
    range: DateRange,
  ): Promise<Record<string, unknown>[]> {
    return this.queryAll({
      TableName: this.table,
      IndexName: "gsi1-account",
      KeyConditionExpression: "gsi1pk = :pk AND gsi1sk BETWEEN :from AND :to",
      ExpressionAttributeValues: {
        ":pk": keys.accountIndex(tenantId, accountId, range.from, "").gsi1pk,
        ":from": range.from,
        ":to": `${range.to}￿`,
      },
    });
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
    const { transactions, enrichments } = await this.listRange(tenantId, range);
    const enriched = new Set(enrichments.map((e) => String(e["dedupKey"])));
    const outstanding = transactions.filter((t) => !enriched.has(String(t["dedupKey"])));
    return limit === undefined ? outstanding : outstanding.slice(0, limit);
  }

  async listPending(tenantId: string, accountId: string): Promise<Record<string, unknown>[]> {
    return this.queryAll({
      TableName: this.table,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: {
        ":pk": keys.pending(tenantId, accountId, "", "").pk,
      },
    });
  }

  async listAccounts(tenantId: string): Promise<Record<string, unknown>[]> {
    return this.queryByPrefix(tenantId, "ACCOUNT#");
  }

  async listConsents(tenantId: string): Promise<Record<string, unknown>[]> {
    return this.queryByPrefix(tenantId, "CONSENT#");
  }

  // ------------------------------------------------------------ internals

  private async queryByPrefix(tenantId: string, prefix: string): Promise<Record<string, unknown>[]> {
    return this.queryAll({
      TableName: this.table,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
      ExpressionAttributeValues: { ":pk": `T#${tenantId}`, ":sk": prefix },
    });
  }

  /** Query every page. Callers deal in complete result sets at this volume. */
  private async queryAll(input: QueryCommandInput): Promise<Record<string, unknown>[]> {
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
   * BatchWriteItem can return UnprocessedItems on throttling without failing,
   * so ignoring the response silently drops rows — the kind of data loss that
   * shows up months later as a missing transaction.
   */
  private async batchWrite(requests: readonly Record<string, unknown>[]): Promise<void> {
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
}
