import { describe, it, expect, beforeAll } from "vitest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  dedupKey,
  type Transaction,
} from "@tightarse/domain";
import { DynamoStore } from "../src/dynamo-store";
import { resolveTestTarget } from "../src/test-table";

/**
 * Integration tests against a real DynamoDB.
 *
 * Parameterised by endpoint so they run against either an ephemeral table in
 * the test region or DynamoDB Local:
 *
 *   LEDGER_TEST_TABLE=tightarse-citest-local npm test -w @tightarse/dynamodb
 *   LEDGER_TEST_TABLE=DynamoStore LEDGER_TEST_ENDPOINT=http://localhost:8000 npm test …
 *
 * Skipped entirely when unset, so CI without credentials stays green.
 *
 * Nothing is written under a tenant that is cleaned up afterwards, and nothing
 * sweeps rows — see `testLedger` below. What keeps these away from real
 * financial data is `resolveTestTarget`, which refuses any table on real
 * DynamoDB that is not named for this purpose, in the region that holds none.
 */

const TABLE = process.env["LEDGER_TEST_TABLE"];
const ENDPOINT = process.env["LEDGER_TEST_ENDPOINT"];
const TENANT = `itest-${Date.now()}`;

/**
 * Retry until a condition holds, for reads that are eventually consistent.
 *
 * Only index reads need this. The base table is read-after-write consistent and
 * anything using it should fail immediately rather than be given time to pass.
 */
async function eventually<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  attempts = 20,
): Promise<T> {
  let last = await read();
  for (let i = 0; i < attempts && !ok(last); i++) {
    await new Promise((r) => setTimeout(r, 250));
    last = await read();
  }
  return last;
}

const suite = TABLE ? describe : describe.skip;

/**
 * One client and one tenant for every suite.
 *
 * Three suites used to build this each for themselves, and because a `ledger`
 * declared in one `suite()` is invisible in the next, that produced two
 * failures in a single afternoon.
 *
 * Nothing cleans up. The store is thrown away after every run — an ephemeral
 * table in the test region, a fresh DynamoDB Local container in CI — so
 * sweeping rows protects nothing and fails confusingly when the scoping is
 * wrong. If these are ever pointed at a store that outlives the run, that
 * assumption is what breaks.
 */
function testLedger(): { ledger: DynamoStore; doc: DynamoDBDocumentClient } {
  // Throws rather than falling back if this run is aimed anywhere it should not
  // be. Reached only inside a suite that already skipped without a table, so an
  // unconfigured machine still gets a skip rather than a failure.
  const target = resolveTestTarget(process.env);
  const doc = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: target.region,
      ...(target.endpoint ? { endpoint: target.endpoint } : {}),
      // DynamoDB Local checks that credentials exist, not what they are, and
      // supplying them here is what lets the documented local command work.
      // Without it the run depends on the machine having some ambient profile,
      // which CI provided in its env block and a laptop does not — so these
      // twelve failed with CredentialsProviderError against a healthy emulator.
      //
      // Against real DynamoDB they must NOT be supplied, or the ambient profile
      // is ignored and every call fails as UnrecognizedClientException.
      ...(target.endpoint
        ? { credentials: { accessKeyId: "local", secretAccessKey: "local" } }
        : {}),
    }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
  return { ledger: new DynamoStore({ tableName: target.tableName, client: doc }), doc };
}


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

suite("DynamoStore (integration)", () => {
  let ledger: DynamoStore;
  let doc: DynamoDBDocumentClient;

  beforeAll(() => {
    ({ ledger, doc } = testLedger());
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

  it("converges on the same row, not merely on the same key", async () => {
    // This test used to count rows and stop there, which is how three separate
    // bugs got through: a plain put replaced the whole row, so every attribute
    // recording when we wrote it changed on each write. The first replay
    // comparison reported 9,790 differences, all of them exactly that, and the
    // reconciliation could not tell when a transaction entered a balance.
    //
    // The rolling sync window refetches ten days daily, so this is the ordinary
    // case and not an edge one.
    const t = txn({ normalisedProviderTransactionId: "stable", timestamp: "2026-05-02T00:00:00Z" });
    await ledger.putTransactions([t], { sourceObject: "raw/first.json.gz" });
    const [before] = (await ledger.listRange(TENANT, { from: "2026-05-02", to: "2026-05-03" })).transactions;

    // Far enough apart that a rewritten timestamp could not coincide.
    await new Promise((r) => setTimeout(r, 1100));
    await ledger.putTransactions([t], { sourceObject: "raw/second.json.gz" });
    const [after] = (await ledger.listRange(TENANT, { from: "2026-05-02", to: "2026-05-03" })).transactions;

    expect(after).toEqual(before);
    // Named individually, so a failure says which half of the guarantee broke.
    expect(after!["ingestedAt"]).toBe(before!["ingestedAt"]);
    expect(after!["sourceObject"]).toBe("raw/first.json.gz");
  });

  it("drops an attribute that is explicitly undefined rather than failing", async () => {
    // An optional field the provider did not send arrives as undefined once it
    // has been through a mapper. DynamoDB rejects undefined outright, so writing
    // it would fail the whole object and stall the ledger on one absent field.
    const t = txn({ normalisedProviderTransactionId: "undef", timestamp: "2026-05-04T00:00:00Z" });
    await ledger.putTransactions([{ ...t, merchantName: undefined }]);

    const [row] = (await ledger.listRange(TENANT, { from: "2026-05-04", to: "2026-05-05" })).transactions;
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("merchantName");
  });

  it("still updates what the transaction itself says", async () => {
    // Preserving provenance must not freeze the row. A settled amount can be
    // corrected by the provider, and the correction has to land.
    const t = txn({ normalisedProviderTransactionId: "amend", timestamp: "2026-05-03T00:00:00Z", amount: -1000 });
    await ledger.putTransactions([t]);
    await ledger.putTransactions([{ ...t, amount: -1250 }]);

    const [row] = (await ledger.listRange(TENANT, { from: "2026-05-03", to: "2026-05-04" })).transactions;
    expect(row!["amount"]).toBe(-1250);
  });





  it("serves per-account history from gsi1", async () => {
    await ledger.putTransactions([
      txn({ accountId: "accB", normalisedProviderTransactionId: "b1", timestamp: "2026-02-01T00:00:00Z" }),
    ]);

    // A global secondary index is eventually consistent: a write is visible on
    // the base table immediately and on the index a moment later. Querying at
    // once returned nothing on a table created seconds earlier. Polling states
    // that property rather than hiding it behind a fixed sleep, which would be
    // both slower and still occasionally wrong.
    const rows = await eventually(
      () => ledger.listAccountRange(TENANT, "accB", { from: "2026-01-01", to: "2026-03-01" }),
      (r) => r.length === 1,
    );
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

suite("DynamoStore account merge (integration)", () => {
  let ledger: DynamoStore;
  let doc: DynamoDBDocumentClient;

  beforeAll(() => {
    ({ ledger, doc } = testLedger());
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
      isCard: false,
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
  let ledger: DynamoStore;
  const alice = `alice-${TENANT}@example.com`;
  const bob = `bob-${TENANT}@example.com`;

  beforeAll(() => {
    ({ ledger, doc } = testLedger());
  });

  // Member rows live in their own partitions, so the other suites' sweeps by
  // tenant partition do not reach them. Left behind, they are live grants.
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

suite("balance readings (integration)", () => {
  let ledger: DynamoStore;

  beforeAll(() => {
    ({ ledger } = testLedger());
  });

  const reading = (accountId: string, at: string, balance: number) => ({
    tenantId: TENANT,
    accountId,
    // Both, because the row is keyed on the pair. Equal here: the interesting
    // case where they differ is covered in the mapper's tests.
    asOf: at,
    fetchedAt: at,
    balance,
    currency: "GBP",
  });

  it("keeps every reading rather than replacing the last one", async () => {
    // The whole point: putBalances overwrites, so the ledger held one balance
    // per account and there was nothing to reconcile against.
    await ledger.putBalanceReading(reading("bal-1", "2026-01-01T05:00:00.000Z", 100_00));
    await ledger.putBalanceReading(reading("bal-1", "2026-01-02T05:00:00.000Z", 90_00));
    await ledger.putBalanceReading(reading("bal-1", "2026-01-03T05:00:00.000Z", 80_00));

    const rows = await ledger.listBalanceReadings(TENANT, "bal-1");
    expect(rows).toHaveLength(3);
  });

  it("returns them oldest first, which is the order reconciliation walks", async () => {
    await ledger.putBalanceReading(reading("bal-2", "2026-03-01T05:00:00.000Z", 300));
    await ledger.putBalanceReading(reading("bal-2", "2026-01-01T05:00:00.000Z", 100));
    await ledger.putBalanceReading(reading("bal-2", "2026-02-01T05:00:00.000Z", 200));

    const rows = await ledger.listBalanceReadings(TENANT, "bal-2");
    expect(rows.map((r) => r["balance"])).toEqual([100, 200, 300]);
  });

  it("converges when the same fetch is transformed twice", async () => {
    // Replaying a raw object must not duplicate a reading, or a rebuilt series
    // would disagree with the one it rebuilt.
    const r = reading("bal-3", "2026-01-01T05:00:00.000Z", 500);
    await ledger.putBalanceReading(r);
    await ledger.putBalanceReading(r);
    expect(await ledger.listBalanceReadings(TENANT, "bal-3")).toHaveLength(1);
  });

  it("keeps one account's readings out of another's", async () => {
    await ledger.putBalanceReading(reading("bal-4", "2026-01-01T05:00:00.000Z", 1));
    await ledger.putBalanceReading(reading("bal-5", "2026-01-01T05:00:00.000Z", 2));
    expect(await ledger.listBalanceReadings(TENANT, "bal-4")).toHaveLength(1);
  });

  it("stores a negative balance, which is a card or an overdraft", async () => {
    await ledger.putBalanceReading(reading("bal-6", "2026-01-01T05:00:00.000Z", -56_790));
    const [row] = await ledger.listBalanceReadings(TENANT, "bal-6");
    expect(row!["balance"]).toBe(-56_790);
  });
});

suite("marking a reading dirty (integration)", () => {
  let ledger: DynamoStore;
  beforeAll(() => { ({ ledger } = testLedger()); });

  const at = "2026-06-01T05:00:00.000Z";
  const reading = (accountId: string) => ({
    tenantId: TENANT, accountId, asOf: at, fetchedAt: at, balance: 100_00, currency: "GBP",
  });

  it("marks a reading and records how far off it was", async () => {
    await ledger.putBalanceReading(reading("dirty-1"));
    await ledger.markBalanceReadingDirty(TENANT, "dirty-1", at, at, -20_00);
    const [row] = await ledger.listBalanceReadings(TENANT, "dirty-1");
    expect(row).toMatchObject({ dirty: true, discrepancy: -20_00 });
  });

  it("clears the mark when the reading reconciles again", async () => {
    // A break explained by a late transaction has to stop being one, or marks
    // would only ever accumulate.
    await ledger.putBalanceReading(reading("dirty-2"));
    await ledger.markBalanceReadingDirty(TENANT, "dirty-2", at, at, -1);
    await ledger.clearBalanceReadingDirty(TENANT, "dirty-2", at, at);
    const [row] = await ledger.listBalanceReadings(TENANT, "dirty-2");
    expect(row).not.toHaveProperty("dirty");
    expect(row).not.toHaveProperty("discrepancy");
  });

  it("refuses to mark a reading that does not exist", async () => {
    // Creating one here would invent a balance out of a failed check.
    await expect(
      ledger.markBalanceReadingDirty(TENANT, "dirty-none", at, at, -1),
    ).rejects.toThrow();
    expect(await ledger.listBalanceReadings(TENANT, "dirty-none")).toHaveLength(0);
  });

  it("leaves the balance itself untouched when marking", async () => {
    // The number is kept. Marking must not quietly adjust it toward what would
    // have reconciled.
    await ledger.putBalanceReading(reading("dirty-3"));
    await ledger.markBalanceReadingDirty(TENANT, "dirty-3", at, at, -5_00);
    const [row] = await ledger.listBalanceReadings(TENANT, "dirty-3");
    expect(row!["balance"]).toBe(100_00);
  });
});

suite("versioned rule sets and categorisations", () => {
  let ledger: DynamoStore;

  beforeAll(() => {
    ({ ledger } = testLedger());
  });

  const set = (version: number, order = 100) => ({
    setId: `household-${TENANT}`,
    version,
    name: "Household",
    order,
    authored: true,
    rules: [
      {
        matcher: { kind: "merchant" as const, pattern: "^SOMESHOP" },
        contributes: { kind: "assert" as const, category: "Groceries" },
        appliesTo: "debits" as const,
      },
    ],
    status: "effective" as const,
    createdAt: new Date().toISOString(),
  });

  it("publishes a version and a current pointer that agree", async () => {
    await ledger.putRuleSetVersion(TENANT, set(1));
    const current = (await ledger.listRuleSets(TENANT)).filter(
      (r) => r["setId"] === `household-${TENANT}`,
    );
    expect(current).toHaveLength(1);
    expect(current[0]!["version"]).toBe(1);
  });

  it("moves the pointer without losing the old version", async () => {
    await ledger.putRuleSetVersion(TENANT, set(2));
    const current = (await ledger.listRuleSets(TENANT)).filter(
      (r) => r["setId"] === `household-${TENANT}`,
    );
    // Still one current row, now pointing at 2.
    expect(current).toHaveLength(1);
    expect(current[0]!["version"]).toBe(2);
    // And version 1 is still readable, because a categorisation naming it has to
    // stay interpretable.
    const history = await ledger.listRuleSetHistory(TENANT, `household-${TENANT}`);
    expect(history.map((h) => h["version"])).toEqual([1, 2]);
  });

  it("refuses to rewrite a published version", async () => {
    // Provenance would otherwise change meaning after the fact: a categorisation
    // says it was produced by version 1, and version 1 must still be what it was.
    await expect(ledger.putRuleSetVersion(TENANT, set(1, 999))).rejects.toThrow();
    const history = await ledger.listRuleSetHistory(TENANT, `household-${TENANT}`);
    expect(history.find((h) => h["version"] === 1)?.["order"]).toBe(100);
  });

  it("keeps current rule sets out of the history partition and vice versa", async () => {
    // The read every fold run makes must not grow as history accumulates.
    const current = await ledger.listRuleSets(TENANT);
    expect(current.every((r) => String(r["sk"]).startsWith("RULESET#"))).toBe(true);
    const history = await ledger.listRuleSetHistory(TENANT, `household-${TENANT}`);
    expect(history.every((r) => !String(r["sk"]).startsWith("RULESET#"))).toBe(true);
  });

  const categorisation = (setId: string, version: number, category: string) => ({
    dedupKey: `cat-${TENANT}`,
    timestamp: "2026-03-01T00:00:00Z",
    category,
    setId,
    setVersion: 1,
    rules: [],
    version,
    status: "effective" as const,
    tags: [],
    appliedAt: new Date().toISOString(),
  });

  it("gives each set its own current row rather than colliding", async () => {
    // Without the set id in the key these overwrite each other, and the second
    // set silently wins.
    await ledger.putCategorisation(TENANT, categorisation("household", 1, "Groceries"));
    await ledger.putCategorisation(TENANT, categorisation("built-in", 1, "Shopping"));

    const { categorisations } = await ledger.listRange(TENANT, {
      from: "2026-03-01",
      to: "2026-03-02",
    });
    const mine = categorisations.filter((c) => c["dedupKey"] === `cat-${TENANT}`);
    expect(mine.map((c) => c["setId"]).sort()).toEqual(["built-in", "household"]);
  });

  it("returns one row per set in the batch read however deep the history", async () => {
    await ledger.putCategorisation(TENANT, categorisation("household", 2, "Fuel"));
    await ledger.putCategorisation(TENANT, categorisation("household", 3, "Transport"));

    const { categorisations } = await ledger.listRange(TENANT, {
      from: "2026-03-01",
      to: "2026-03-02",
    });
    const household = categorisations.filter(
      (c) => c["dedupKey"] === `cat-${TENANT}` && c["setId"] === "household",
    );
    // Three versions written, one row read. This is the whole point of keying
    // the current row by set rather than by version.
    expect(household).toHaveLength(1);
    expect(household[0]!["version"]).toBe(3);
    expect(household[0]!["category"]).toBe("Transport");
  });

  it("keeps every version, ordered, for the question 'why did this change?'", async () => {
    const history = (await ledger.listCategorisationHistory(TENANT, `cat-${TENANT}`)).filter(
      (h) => h["setId"] === "household",
    );
    expect(history.map((h) => h["version"])).toEqual([1, 2, 3]);
    expect(history.map((h) => h["category"])).toEqual(["Groceries", "Fuel", "Transport"]);
  });
});

suite("control plane: settings, consents and the legacy rules row", () => {
  let store: DynamoStore;

  beforeAll(() => {
    ({ ledger: store } = testLedger());
  });

  // These seven methods had no test naming them. Hidden inside a thirty-method
  // class at 88% coverage that reads as fine; as the control plane — the data
  // nothing can regenerate — it is the wrong half to leave unexercised.

  it("returns no settings for a household that has none", async () => {
    // Distinct from a household that has turned enrichment off. The categoriser
    // defaults to rules mode on null and skips entirely on "off", so confusing
    // the two silently changes behaviour.
    expect(await store.getSettings(`${TENANT}-absent`)).toBeNull();
  });

  it("round-trips settings", async () => {
    const settings = { tenantId: TENANT, baseCurrency: "GBP", updatedAt: "2026-08-18T00:00:00Z" };
    await store.putSettings({ ...settings, enrichment: "off" });
    expect((await store.getSettings(TENANT))?.enrichment).toBe("off");
    await store.putSettings({ ...settings, enrichment: "rules" });
    expect((await store.getSettings(TENANT))?.enrichment).toBe("rules");
  });

  it("reads the legacy rules row, and says nothing for a household without one", async () => {
    // Read-only now: it is the source the first seed converts, and deleting a
    // source during a migration removes the only way to check the result. A
    // household's rules are a versioned `household` set.
    expect(await store.getCustomRules(`${TENANT}-absent`)).toEqual([]);
  });


  it("records a consent and lists it", async () => {
    await store.putConsent({
      tenantId: TENANT,
      consentId: `conn-${TENANT}`,
      provider: "truelayer",
      grantedAt: "2026-08-18T00:00:00Z",
      expiresAt: "2026-11-16T00:00:00Z",
      status: "active",
    });
    const consents = await store.listConsents(TENANT);
    expect(consents.map((c) => c["consentId"])).toContain(`conn-${TENANT}`);
  });

});

suite("the category catalogue", () => {
  let store: DynamoStore;

  beforeAll(() => {
    ({ ledger: store } = testLedger());
  });

  it("writes a category and reads it back by its id", async () => {
    await store.putCategory(TENANT, {
      id: "groceries",
      label: "Groceries",
      kind: "spending",
      taxonomy: "household",
      retired: false,
    });
    // `kind` is the category's own — spending, income or movement. A row-kind
    // marker of the same name overwrote it, which made every category read as
    // kind "CATEGORY" and would have broken every total that branches on it.
    const all = await store.listCategories(TENANT);
    expect(all.find((c) => c["id"] === "groceries")).toMatchObject({ label: "Groceries", kind: "spending" });
  });

  it("overwrites a label in place, because a label is presentation", async () => {
    // The whole point of the entity: renaming is a one-field edit rather than a
    // rewrite of every row referencing it.
    const base = { id: "renamed", kind: "spending" as const, taxonomy: "household" as const, retired: false };
    await store.putCategory(TENANT, { ...base, label: "Before" });
    await store.putCategory(TENANT, { ...base, label: "After" });
    const found = (await store.listCategories(TENANT)).filter((c) => c["id"] === "renamed");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ label: "After" });
  });

  it("keeps categories out of the range query the ledger makes", async () => {
    // CATEGORY# shares the tenant partition with ACCOUNT# and RULESET#, and a
    // fold run must not have to read and discard the catalogue.
    await store.putCategory(TENANT, {
      id: "unseen",
      label: "Unseen",
      kind: "spending",
      taxonomy: "household",
      retired: false,
    });
    const sets = await store.listRuleSets(TENANT);
    expect(sets.some((r) => r["id"] === "unseen")).toBe(false);
  });
});

suite("proposals", () => {
  let ledger: DynamoStore;
  const TEN = `prop-${Date.now()}`;

  beforeAll(() => {
    ({ ledger } = testLedger());
  });

  const proposal = (version: number, category = "Groceries") => ({
    setId: "built-in",
    version,
    name: "Shipped",
    order: 2,
    authored: false,
    status: "proposed" as const,
    rules: [
      {
        matcher: { kind: "merchant" as const, pattern: "^SOMESHOP" },
        contributes: { kind: "assert" as const, category },
        appliesTo: "debits" as const,
      },
    ],
    createdAt: new Date().toISOString(),
  });

  it("does not make a proposed version current", async () => {
    // It has to be reviewable without changing what the fold does, or reviewing
    // it would be decoration.
    await ledger.putRuleSetVersion(TEN, proposal(1));
    expect(await ledger.listRuleSets(TEN)).toEqual([]);
    expect(await ledger.listRuleSetHistory(TEN, "built-in")).toHaveLength(1);
  });

  it("makes it current when it is accepted", async () => {
    await ledger.decideRuleSetVersion(TEN, "built-in", 1, { status: "effective" });
    const current = await ledger.listRuleSets(TEN);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ version: 1, status: "effective" });
  });

  it("refuses to decide the same version twice", async () => {
    // Two people deciding at once must not both win.
    await expect(
      ledger.decideRuleSetVersion(TEN, "built-in", 1, { status: "rejected", because: "changed my mind" }),
    ).rejects.toThrow();
  });

  it("records why a proposal was rejected, and leaves current alone", async () => {
    // A declined proposal that leaves no trace is one the next run makes again.
    await ledger.putRuleSetVersion(TEN, proposal(2, "Shopping"));
    await ledger.decideRuleSetVersion(TEN, "built-in", 2, { status: "rejected", because: "loses 139 merchants" });

    const history = await ledger.listRuleSetHistory(TEN, "built-in");
    const rejected = history.find((h) => h["version"] === 2);
    expect(rejected).toMatchObject({ status: "rejected", rejectedBecause: "loses 139 merchants" });

    const current = await ledger.listRuleSets(TEN);
    expect(current[0]).toMatchObject({ version: 1 });
  });
});
