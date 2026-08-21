import { describe, it, expect } from "vitest";
import { datasetForEndpoint, parseRawKey, rawObjectKey } from "../src/raw/keys.js";

/**
 * How the raw landing zone is laid out.
 *
 * Untested until now, which is the wrong way round: the raw zone is the one
 * asset that cannot be rebuilt, and these three functions decide where every
 * object lands and how it is read back. A replay of five years reads the dataset
 * out of the key to know what it is looking at, so a change here is not a
 * renaming — it is the difference between a rebuild and an archive nobody can
 * interpret.
 */

describe("naming a dataset from the endpoint that answered", () => {
  it("distinguishes an account's transactions from a card's", () => {
    // The one distinction the sign convention depends on. Cards are reported from
    // the issuer's point of view, so conflating the two datasets is how every card
    // purchase became income.
    expect(datasetForEndpoint("/data/v1/accounts/{id}/transactions")).toBe("truelayer.transactions");
    expect(datasetForEndpoint("/data/v1/cards/{id}/transactions")).toBe("truelayer.card_transactions");
  });

  it("replaces a real account id with a placeholder", () => {
    // Ids are 32 hex characters. Without the substitution every account would map
    // to no dataset at all and the whole sync would fail on the first item.
    const id = "a".repeat(32);
    expect(datasetForEndpoint(`/data/v1/accounts/${id}/balance`)).toBe("truelayer.balance");
    expect(datasetForEndpoint(`/data/v1/cards/${id}/transactions/pending`)).toBe(
      "truelayer.card_transactions_pending",
    );
  });

  it("refuses an endpoint it does not know rather than inventing a name", () => {
    // A silent fallback would write objects under a dataset the transform has no
    // handler for, and they would sit in the raw zone looking fine.
    expect(() => datasetForEndpoint("/data/v1/accounts/{id}/loans")).toThrow(/No dataset mapping/);
  });
});

describe("where an object lands", () => {
  const args = {
    tenantId: "frost",
    dataset: "truelayer.transactions",
    accountId: "acc-1",
    fetchedAt: "2026-08-20T05:00:26.244Z",
    contentHash: "0123456789abcdef0123",
  };

  it("leads with the tenant, so erasure is one prefix delete", () => {
    // And so a single IAM condition can scope a principal to one household.
    expect(rawObjectKey(args).startsWith("tenant=frost/")).toBe(true);
  });

  it("orders lexicographically by fetch time, which is why there is no date partition", () => {
    const earlier = rawObjectKey({ ...args, fetchedAt: "2026-08-19T05:00:00.000Z" });
    expect(rawObjectKey(args) > earlier).toBe(true);
  });

  it("puts identical content on the same key rather than accumulating duplicates", () => {
    // The hash is of the body, so re-uploading the same response is a no-op.
    expect(rawObjectKey(args)).toBe(rawObjectKey({ ...args }));
  });

  it("omits the account segment for a listing, which belongs to no account", () => {
    const key = rawObjectKey({ ...args, dataset: "truelayer.accounts", accountId: undefined });
    expect(key).not.toContain("account=");
  });
});

describe("reading a key back", () => {
  it("round-trips what was written", () => {
    // The transform is handed a key by an S3 event and must know the household and
    // dataset before it can parse the body.
    const key = rawObjectKey({
      tenantId: "frost",
      dataset: "truelayer.card_transactions",
      accountId: "card-1",
      fetchedAt: "2026-08-20T05:00:26.244Z",
      contentHash: "abcdef0123456789abcd",
    });
    expect(parseRawKey(key)).toMatchObject({
      tenantId: "frost",
      dataset: "truelayer.card_transactions",
      accountId: "card-1",
    });
    expect(parseRawKey(key).filename.endsWith(".json.gz")).toBe(true);
  });

  it("reports no account rather than an empty one, for a listing", () => {
    const key = rawObjectKey({
      tenantId: "frost",
      dataset: "truelayer.accounts",
      fetchedAt: "2026-08-20T05:00:26.244Z",
      contentHash: "abcdef0123456789abcd",
    });
    expect(parseRawKey(key)).not.toHaveProperty("accountId");
  });

  it("refuses anything that is not a raw object key", () => {
    // The transform would otherwise carry on with an undefined tenant and write
    // rows into somebody else's partition.
    expect(() => parseRawKey("some/other/object.json")).toThrow(/Not a raw object key/);
    expect(() => parseRawKey("tenant=frost/no-dataset/x.json.gz")).toThrow(/Not a raw object key/);
  });
});
