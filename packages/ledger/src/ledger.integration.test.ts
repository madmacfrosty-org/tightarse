import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DynamoDBClient, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { dedupKey, type Transaction } from "@tightarse/schema";
import { Ledger } from "./ledger";

/**
 * Integration tests against a real DynamoDB.
 *
 * Parameterised by endpoint so they run against either the deployed dev table
 * or DynamoDB Local:
 *
 *   LEDGER_TEST_TABLE=<name> AWS_PROFILE=tightarse-dev npm test -w @tightarse/ledger
 *   LEDGER_TEST_TABLE=Ledger LEDGER_TEST_ENDPOINT=http://localhost:8000 npm test …
 *
 * Skipped entirely when unset, so CI without credentials stays green.
 *
 * Everything is written under a throwaway tenant and deleted afterwards — these
 * must never leave rows in a table that also holds real financial data.
 */

const TABLE = process.env["LEDGER_TEST_TABLE"];
const ENDPOINT = process.env["LEDGER_TEST_ENDPOINT"];
const TENANT = `itest-${Date.now()}`;

const suite = TABLE ? describe : describe.skip;

const txn = (over: Partial<Transaction> = {}): Transaction => ({
  tenantId: TENANT,
  accountId: "accA",
  transactionId: "tx-1",
  normalisedProviderTransactionId: "norm-1",
  timestamp: "2026-03-15T00:00:00Z",
  amount: -1299,
  currency: "GBP",
  description: "SHOP",
  status: "settled",
  transactionType: "DEBIT",
  ...over,
});

suite("Ledger (integration)", () => {
  let ledger: Ledger;
  let doc: DynamoDBDocumentClient;

  beforeAll(() => {
    doc = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        region: process.env["AWS_REGION"] ?? "eu-west-1",
        ...(ENDPOINT ? { endpoint: ENDPOINT } : {}),
      }),
      { marshallOptions: { removeUndefinedValues: true } },
    );
    ledger = new Ledger({ tableName: TABLE!, client: doc });
  });

  afterAll(async () => {
    // Sweep every partition this suite could have written to.
    const raw = new DynamoDBClient({
      region: process.env["AWS_REGION"] ?? "eu-west-1",
      ...(ENDPOINT ? { endpoint: ENDPOINT } : {}),
    });
    for (const pk of [`T#${TENANT}#TX`, `T#${TENANT}`, `T#${TENANT}#PEND#accA`, `T#${TENANT}#PEND#accB`]) {
      const res = await doc.send(
        new QueryCommand({
          TableName: TABLE!,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": pk },
        }),
      );
      for (const item of res.Items ?? []) {
        await raw.send(
          new DeleteItemCommand({
            TableName: TABLE!,
            Key: { pk: { S: String(item["pk"]) }, sk: { S: String(item["sk"]) } },
          }),
        );
      }
    }
  });

  it("round-trips transactions through a date range query", async () => {
    await ledger.putTransactions([
      txn({ normalisedProviderTransactionId: "norm-1", timestamp: "2026-03-15T00:00:00Z" }),
      txn({ normalisedProviderTransactionId: "norm-2", timestamp: "2026-04-02T00:00:00Z" }),
      txn({ normalisedProviderTransactionId: "norm-3", timestamp: "2026-09-01T00:00:00Z" }),
    ]);

    const march = await ledger.listRange(TENANT, { from: "2026-03-01", to: "2026-05-01" });
    expect(march.transactions).toHaveLength(2);

    // Spanning months is one query, not one per month — the point of dropping
    // the month partition.
    const all = await ledger.listRange(TENANT, { from: "2026-01-01", to: "2027-01-01" });
    expect(all.transactions).toHaveLength(3);
  });

  it("is idempotent, so replaying raw converges instead of duplicating", async () => {
    const t = txn({ normalisedProviderTransactionId: "dupe", timestamp: "2026-05-01T00:00:00Z" });
    await ledger.putTransactions([t]);
    await ledger.putTransactions([t]);
    await ledger.putTransactions([t]);

    const found = await ledger.listRange(TENANT, { from: "2026-05-01", to: "2026-05-02" });
    expect(found.transactions).toHaveLength(1);
  });

  it("returns a transaction and its enrichment from one query, adjacent", async () => {
    const t = txn({ normalisedProviderTransactionId: "enr", timestamp: "2026-06-10T00:00:00Z" });
    await ledger.putTransactions([t]);
    await ledger.putEnrichment({
      tenantId: TENANT,
      dedupKey: dedupKey(t),
      timestamp: "2026-06-10T00:00:00Z",
      category: "Groceries",
      confidence: 0.91,
      producedBy: "itest",
      producedAt: new Date().toISOString(),
    });

    const res = await ledger.listRange(TENANT, { from: "2026-06-01", to: "2026-07-01" });
    expect(res.transactions).toHaveLength(1);
    expect(res.enrichments).toHaveLength(1);
    expect(res.enrichments[0]!["category"]).toBe("Groceries");
  });

  it("drops a transaction from the backlog once enriched", async () => {
    const range = { from: "2026-07-01", to: "2026-08-01" };
    const t = txn({ normalisedProviderTransactionId: "backlog", timestamp: "2026-07-04T00:00:00Z" });
    await ledger.putTransactions([t]);

    const before = await ledger.listToEnrich(TENANT, range);
    expect(before.some((r) => r["dedupKey"] === dedupKey(t))).toBe(true);

    await ledger.putEnrichment({
      tenantId: TENANT,
      dedupKey: dedupKey(t),
      timestamp: "2026-07-04T00:00:00Z",
      category: "Transport",
      confidence: 0.8,
      producedBy: "itest",
      producedAt: new Date().toISOString(),
    });

    expect(await ledger.listToEnrich(TENANT, range)).toHaveLength(0);
  });

  it("does NOT re-queue an enriched transaction when its raw object is replayed", async () => {
    // The regression this whole design exists to prevent. Replay is the point
    // of the landing zone, so re-queueing on replay would make a full re-run of
    // the categoriser the normal case — at LLM cost, and overwriting any
    // hand-corrected category with the model's original answer.
    const range = { from: "2026-10-01", to: "2026-11-01" };
    const t = txn({ normalisedProviderTransactionId: "replay", timestamp: "2026-10-10T00:00:00Z" });

    await ledger.putTransactions([t]);
    await ledger.putEnrichment({
      tenantId: TENANT,
      dedupKey: dedupKey(t),
      timestamp: "2026-10-10T00:00:00Z",
      category: "Groceries",
      confidence: 0.9,
      producedBy: "itest",
      producedAt: new Date().toISOString(),
    });
    expect(await ledger.listToEnrich(TENANT, range)).toHaveLength(0);

    await ledger.putTransactions([t]);
    expect(await ledger.listToEnrich(TENANT, range)).toHaveLength(0);
  });

  it("refuses an enrichment for a transaction that does not exist", async () => {
    await expect(
      ledger.putEnrichment({
        tenantId: TENANT,
        dedupKey: "n:ghost",
        timestamp: "2026-01-01T00:00:00Z",
        category: "Nothing",
        confidence: 1,
        producedBy: "itest",
        producedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow();
  });

  it("serves per-account history from gsi1", async () => {
    await ledger.putTransactions([
      txn({ accountId: "accB", normalisedProviderTransactionId: "b1", timestamp: "2026-02-01T00:00:00Z" }),
    ]);
    const rows = await ledger.listAccountRange(TENANT, "accB", { from: "2026-01-01", to: "2026-03-01" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!["accountId"]).toBe("accB");
  });

  it("replaces the pending set rather than merging it", async () => {
    await ledger.replacePending(TENANT, "accA", [
      txn({ status: "pending", providerTransactionId: "p1", timestamp: "2026-08-01T00:00:00Z" }),
      txn({ status: "pending", providerTransactionId: "p2", timestamp: "2026-08-02T00:00:00Z" }),
    ]);
    expect(await ledger.listPending(TENANT, "accA")).toHaveLength(2);

    // p1 settled and p2 vanished — the classic pending behaviour.
    const second = await ledger.replacePending(TENANT, "accA", [
      txn({ status: "pending", providerTransactionId: "p3", timestamp: "2026-08-03T00:00:00Z" }),
    ]);
    expect(second.deleted).toBe(2);
    const now = await ledger.listPending(TENANT, "accA");
    expect(now).toHaveLength(1);
    expect(String(now[0]!["sk"])).toContain("p3");
  });
});

suite("Ledger account merge (integration)", () => {
  let ledger: Ledger;
  let doc: DynamoDBDocumentClient;

  beforeAll(() => {
    doc = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        region: process.env["AWS_REGION"] ?? "eu-west-1",
        ...(ENDPOINT ? { endpoint: ENDPOINT } : {}),
      }),
      { marshallOptions: { removeUndefinedValues: true } },
    );
    ledger = new Ledger({ tableName: TABLE!, client: doc });
  });

  afterAll(async () => {
    // This suite runs after the first suite's afterAll, so it must sweep its
    // own rows or it leaves them behind in a table holding real financial data.
    const raw = new DynamoDBClient({
      region: process.env["AWS_REGION"] ?? "eu-west-1",
      ...(ENDPOINT ? { endpoint: ENDPOINT } : {}),
    });
    const res = await doc.send(
      new QueryCommand({
        TableName: TABLE!,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": `T#${TENANT}` },
      }),
    );
    for (const item of res.Items ?? []) {
      await raw.send(
        new DeleteItemCommand({
          TableName: TABLE!,
          Key: { pk: { S: String(item["pk"]) }, sk: { S: String(item["sk"]) } },
        }),
      );
    }
  });

  it("does not lose a balance when account details are written afterwards", async () => {
    // The real failure: /balance wrote the card's balance, then the /cards list
    // object rewrote the account row without one and wiped it. Regular accounts
    // survived only because "balance" sorts after "accounts"; under S3 events,
    // where order is arbitrary, they were equally exposed.
    const account = {
      tenantId: TENANT,
      accountId: "mergeTest",
      provider: "truelayer" as const,
      providerAccountId: "mergeTest",
      displayName: "Test",
      institutionName: "TEST-BANK",
      currency: "GBP",
    };

    await ledger.putAccount(account, { current: 181447, available: 558553 });
    await ledger.putAccount(account); // the list object, with no balance

    const rows = await ledger.listAccounts(TENANT);
    const found = rows.find((r) => r["accountId"] === "mergeTest");
    expect(found?.["currentBalance"]).toBe(181447);
    expect(found?.["availableBalance"]).toBe(558553);
  });

  it("updates balances without erasing the account's identity", async () => {
    // The balance endpoint knows an account id and nothing else. Writing a
    // whole account row from it — the old behaviour — replaced the real
    // institution with the placeholder "unknown" on every single sync, which
    // is exactly what the live ledger showed for every current account.
    await ledger.putAccount({
      tenantId: TENANT,
      accountId: "accBal",
      provider: "truelayer" as const,
      providerAccountId: "accBal",
      displayName: "Current Account",
      institutionName: "FIRST-DIRECT",
      currency: "GBP",
      isCard: false,
    });
    await ledger.putBalances(TENANT, "accBal", { current: 12345, available: 20000, currency: "GBP" });

    const found = (await ledger.listAccounts(TENANT)).find((r) => r["accountId"] === "accBal");
    expect(found?.["institutionName"]).toBe("FIRST-DIRECT");
    expect(found?.["displayName"]).toBe("Current Account");
    expect(found?.["currentBalance"]).toBe(12345);
    expect(found?.["availableBalance"]).toBe(20000);
  });
});

suite("household access", () => {
  let doc: DynamoDBDocumentClient;
  let ledger: Ledger;
  const alice = `alice-${TENANT}@example.com`;
  const bob = `bob-${TENANT}@example.com`;

  beforeAll(() => {
    doc = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        region: process.env["AWS_REGION"] ?? "eu-west-1",
        ...(ENDPOINT ? { endpoint: ENDPOINT } : {}),
      }),
      { marshallOptions: { removeUndefinedValues: true } },
    );
    ledger = new Ledger({ tableName: TABLE!, client: doc });
  });

  // Member rows live in their own partitions, so the other suites' sweeps by
  // tenant partition do not reach them. Left behind, they are live grants.
  afterAll(async () => {
    await ledger.deleteMember(alice);
    await ledger.deleteMember(bob);
  });

  it("grants, lists and revokes", async () => {
    await ledger.putMember({ email: alice, tenantId: TENANT, addedAt: new Date().toISOString() });
    await ledger.putMember({ email: bob, tenantId: TENANT, addedAt: new Date().toISOString() });

    const mine = (await ledger.listMembers()).filter((m) => m.tenantId === TENANT);
    expect(mine.map((m) => m.email).sort()).toEqual([alice, bob].sort());

    await ledger.deleteMember(alice);
    expect(await ledger.getMemberTenant(alice)).toBeNull();
    expect(await ledger.getMemberTenant(bob)).toBe(TENANT);
  });

  it("matches an address regardless of case or surrounding space", async () => {
    // Identity providers are not consistent about either, and a lookup miss
    // here reads as "no household assigned" — a broken app, not a missing row.
    await ledger.putMember({ email: alice, tenantId: TENANT, addedAt: new Date().toISOString() });
    expect(await ledger.getMemberTenant(`  ${alice.toUpperCase()} `)).toBe(TENANT);
  });

  it("returns null for someone who was never granted access", async () => {
    // Fail closed. A default here would hand an unknown identity a ledger.
    expect(await ledger.getMemberTenant("stranger@example.com")).toBeNull();
  });
});
