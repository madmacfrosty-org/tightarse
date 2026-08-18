import { describe, it, expect } from "vitest";
import { RowKind, type Transaction, type TransactionEnrichment } from "@tightarse/schema";
import { categorisationItems, ruleSetItems, transactionItem, enrichmentItem, pendingItem } from "./items";

const txn = (over: Partial<Transaction> = {}): Transaction => ({
  tenantId: "frost",
  accountId: "acc1",
  transactionId: "unstable-id",
  normalisedProviderTransactionId: "stable-id",
  timestamp: "2026-08-08T00:00:00Z",
  amount: -1299,
  currency: "GBP",
  description: "SHOP",
  status: "settled",
  transactionType: "DEBIT",
  ...over,
});

describe("transactionItem", () => {
  it("keys on the dedup chain, never on the unstable transaction id", () => {
    const item = transactionItem(txn());
    expect(item.sk).toMatch(/#n:[0-9a-f]{32}$/);
    expect(item.sk).not.toContain("unstable-id");
  });

  it("writes no backlog marker, so a replay cannot re-queue enriched work", () => {
    const item = transactionItem(txn());
    expect(item["gsi2pk"]).toBeUndefined();
    expect(item["gsi2sk"]).toBeUndefined();
  });

  it("records the raw object it came from when given one", () => {
    const withSource = transactionItem(txn(), { sourceObject: "tenant=frost/dataset=x/y.json.gz" });
    expect(withSource["sourceObject"]).toBe("tenant=frost/dataset=x/y.json.gz");
    // Absent rather than null when not supplied, so it costs nothing on rows
    // that did not come from a raw object.
    expect(transactionItem(txn())["sourceObject"]).toBeUndefined();
  });

  it("produces identical keys for the same transaction, so replay converges", () => {
    const a = transactionItem(txn(), { ingestedAt: "2026-08-09T00:00:00Z" });
    const b = transactionItem(txn(), { ingestedAt: "2026-08-10T00:00:00Z" });
    expect(a.pk).toBe(b.pk);
    expect(a.sk).toBe(b.sk);
  });
});

describe("enrichmentItem", () => {
  it("lands in the same partition and at the same timestamp as its transaction", () => {
    const t = transactionItem(txn());
    const e: TransactionEnrichment = {
      tenantId: "frost",
      dedupKey: "n:stable-id",
      timestamp: "2026-08-08T00:00:00Z",
      category: "Groceries",
      confidence: 0.9,
      producedBy: "test",
      producedAt: "2026-08-09T00:00:00Z",
    };
    const item = enrichmentItem(e);
    expect(item["pk"]).toBe(t.pk);
    // Same timestamp prefix, different kind marker — that adjacency is what
    // lets one range query return both.
    expect(String(item["sk"]).startsWith("2026-08-08T00:00:00Z")).toBe(true);
    expect(String(item["sk"])).toContain(`#${RowKind.enrichment}#`);
  });
});

describe("pendingItem", () => {
  it("carries a TTL so a stopped sync does not leave stale rows looking live", () => {
    const now = new Date("2026-08-09T00:00:00Z");
    const item = pendingItem(txn({ status: "pending" }), { ttlSeconds: 3600, now });
    expect(item["expiresAt"]).toBe(Math.floor(now.getTime() / 1000) + 3600);
    expect(item["status"]).toBe("pending");
  });

  it("keys on the provider id, not the dedup chain — it is a cache, not a ledger row", () => {
    const item = pendingItem(txn({ providerTransactionId: "prov-9" }), { ttlSeconds: 60 });
    expect(String(item["sk"])).toContain("prov-9");
  });
});

describe("rule set rows", () => {
  const set = {
    setId: "household",
    version: 3,
    name: "Household",
    order: 100,
    authored: true,
    rules: [],
    createdAt: "2026-08-18T00:00:00Z",
  };

  it("writes the same body to both rows", () => {
    // The current row is a copy of the version. If they carried different
    // bodies, every skip decision downstream — which reads the copy — would be
    // made against something the record does not say.
    const { current, version } = ruleSetItems("frost", set);
    const strip = (r: Record<string, unknown>) => {
      const { pk, sk, ...rest } = r;
      return rest;
    };
    expect(strip(current)).toEqual(strip(version));
  });

  it("puts the current row where a fold run looks and the version elsewhere", () => {
    const { current, version } = ruleSetItems("frost", set);
    expect(String(current["sk"]).startsWith("RULESET#")).toBe(true);
    expect(current["pk"]).not.toBe(version["pk"]);
  });
});

describe("categorisation rows", () => {
  const c = {
    dedupKey: "d1",
    timestamp: "2026-03-01T00:00:00Z",
    category: "Groceries",
    setId: "household",
    setVersion: 3,
    rules: [],
    version: 2,
    status: "effective" as const,
    tags: [],
    appliedAt: "2026-08-18T00:00:00Z",
  };

  it("keys the current row by set, so two sets cannot overwrite each other", () => {
    const a = categorisationItems("frost", c).current;
    const b = categorisationItems("frost", { ...c, setId: "built-in" }).current;
    expect(a["sk"]).not.toBe(b["sk"]);
  });

  it("keeps the current row in the transaction's partition and history out of it", () => {
    // The batch read must return one row per set however deep the history goes.
    const { current, version } = categorisationItems("frost", c);
    expect(current["pk"]).toBe("T#frost#TX");
    expect(version["pk"]).not.toBe(current["pk"]);
  });

  it("does not let a new version change the current row's key", () => {
    // Otherwise each version would leave a new current row behind and the batch
    // read would grow with churn — the thing this design exists to prevent.
    const v2 = categorisationItems("frost", c).current;
    const v9 = categorisationItems("frost", { ...c, version: 9 }).current;
    expect(v9["sk"]).toBe(v2["sk"]);
    expect(v9["version"]).toBe(9);
  });
});
