import { describe, it, expect } from "vitest";
import { RowKind, type Transaction, type TransactionEnrichment } from "@tightarse/schema";
import { transactionItem, enrichmentItem, pendingItem } from "./items";

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
    expect(item.sk).toContain("n:stable-id");
    expect(item.sk).not.toContain("unstable-id");
  });

  it("writes the gsi2 backlog marker, which is what makes the index sparse", () => {
    const item = transactionItem(txn());
    expect(item.gsi2pk).toBe("T#frost#TOENRICH");
    expect(item.gsi2sk).toBeDefined();
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
