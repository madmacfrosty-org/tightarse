import { describe, it, expect, vi, beforeEach } from "vitest";
import { recordAccountRenames, stillReturned } from "../src/index.js";

/**
 * Finding and recording a rename for a whole household.
 *
 * The part worth testing hardest is `stillReturned`, which infers something the
 * provider told the sync and the sync did not pass on. Every case here is about
 * that inference failing safely: a broken connection, a stale household, a row
 * that never synced. None of them may produce a merge.
 */

const listAccounts = vi.fn();
const listRange = vi.fn();
const markSuperseded = vi.fn(async () => {});
const deps = { ledger: { listAccounts, listRange, markSuperseded } };

const NOW = new Date("2026-11-01T12:00:00.000Z");

const account = (accountId: string, lastSyncedAt?: string, over = {}) => ({
  accountId,
  ...(lastSyncedAt !== undefined ? { lastSyncedAt } : {}),
  ...over,
});
const txn = (accountId: string, providerTransactionId: string, amount = -1234) => ({
  accountId,
  timestamp: "2026-10-01T00:00:00.000Z",
  amount,
  description: "a purchase",
  providerTransactionId,
});

beforeEach(() => {
  vi.clearAllMocks();
  markSuperseded.mockResolvedValue(undefined);
});

describe("which accounts the provider still returns", () => {
  it("counts the ones synced alongside the newest", () => {
    expect(
      stillReturned([
        account("live", "2026-11-01T05:00:00.000Z"),
        account("also", "2026-10-31T05:00:00.000Z"),
      ]),
    ).toEqual(new Set(["live", "also"]));
  });

  it("drops one that stopped syncing days before the rest", () => {
    expect(
      stillReturned([
        account("live", "2026-11-01T05:00:00.000Z"),
        account("gone", "2026-10-22T05:00:00.000Z"),
      ]),
    ).toEqual(new Set(["live"]));
  });

  it("measures against the household's newest sync, not the clock", () => {
    // A household whose last sync was a fortnight ago still has accounts the
    // provider returns. Judging them against today would call every one of
    // them gone — and then conclude nothing, which is safe but useless.
    expect(
      stillReturned([
        account("a", "2026-10-01T05:00:00.000Z"),
        account("b", "2026-10-01T06:00:00.000Z"),
      ]),
    ).toEqual(new Set(["a", "b"]));
  });

  it("returns nothing when no account has ever synced", () => {
    expect(stillReturned([account("a"), account("b")])).toEqual(new Set());
  });

  it("ignores a row whose sync time is not a date", () => {
    expect(
      stillReturned([
        account("live", "2026-11-01T05:00:00.000Z"),
        account("odd", "not-a-date"),
      ]),
    ).toEqual(new Set(["live"]));
  });
});

describe("recording a rename", () => {
  it("writes the link on the account the provider stopped returning", async () => {
    listAccounts.mockResolvedValue([
      account("old", "2026-10-22T05:00:00.000Z"),
      account("new", "2026-11-01T05:00:00.000Z"),
    ]);
    listRange.mockResolvedValue({
      transactions: [
        txn("old", "p1"),
        txn("new", "p1"),
        txn("old", "p2", -99),
        txn("new", "p2", -99),
      ],
      categorisations: [],
    });

    const found = await recordAccountRenames(deps, "frost", NOW);

    expect(found).toEqual([
      {
        supersededId: "old",
        survivingId: "new",
        evidence: { kind: "transaction-overlap", shared: 2 },
      },
    ]);
    expect(markSuperseded).toHaveBeenCalledTimes(1);
    expect(markSuperseded).toHaveBeenCalledWith(
      "frost",
      "old",
      "new",
      NOW.toISOString(),
    );
  });

  it("writes nothing when a whole connection has gone quiet", async () => {
    // Both accounts stale together: a suspended or broken connection, not a
    // rename. The inference has to fail into silence rather than into a merge.
    listAccounts.mockResolvedValue([
      account("old", "2026-09-01T05:00:00.000Z"),
      account("new", "2026-09-01T06:00:00.000Z"),
    ]);
    listRange.mockResolvedValue({
      transactions: [txn("old", "p1"), txn("new", "p1"), txn("old", "p2"), txn("new", "p2")],
      categorisations: [],
    });

    expect(await recordAccountRenames(deps, "frost", NOW)).toEqual([]);
    expect(markSuperseded).not.toHaveBeenCalled();
  });

  it("writes nothing when both are still being returned", async () => {
    listAccounts.mockResolvedValue([
      account("a", "2026-11-01T05:00:00.000Z"),
      account("b", "2026-11-01T05:00:00.000Z"),
    ]);
    listRange.mockResolvedValue({
      transactions: [txn("a", "p1"), txn("b", "p1"), txn("a", "p2"), txn("b", "p2")],
      categorisations: [],
    });

    expect(await recordAccountRenames(deps, "frost", NOW)).toEqual([]);
    expect(markSuperseded).not.toHaveBeenCalled();
  });

  it("offers nothing a second time, so a daily job is harmless", async () => {
    listAccounts.mockResolvedValue([
      account("old", "2026-10-22T05:00:00.000Z", { supersededBy: "new" }),
      account("new", "2026-11-01T05:00:00.000Z"),
    ]);
    listRange.mockResolvedValue({
      transactions: [txn("old", "p1"), txn("new", "p1"), txn("old", "p2"), txn("new", "p2")],
      categorisations: [],
    });

    expect(await recordAccountRenames(deps, "frost", NOW)).toEqual([]);
    expect(markSuperseded).not.toHaveBeenCalled();
  });

  it("reads the whole history, because a rename's evidence can be years old", async () => {
    // The real pair shared 86 transactions going back three years. A ranged
    // read would have found none of them.
    listAccounts.mockResolvedValue([account("a", "2026-11-01T05:00:00.000Z")]);
    listRange.mockResolvedValue({ transactions: [], categorisations: [] });

    await recordAccountRenames(deps, "frost", NOW);

    expect(listRange).toHaveBeenCalledWith("frost", {
      from: "1970-01-01",
      to: "2026-11-01",
    });
  });

  it("uses the normalised provider identifier when the rows carry one", async () => {
    // The identifier the ledger actually holds for every transaction. Testing
    // only the unnormalised one would leave the path that runs in production
    // unexercised.
    const n = (accountId: string, id: string) => ({
      accountId,
      timestamp: "2026-10-01T00:00:00.000Z",
      amount: -500,
      description: "a purchase",
      normalisedProviderTransactionId: id,
    });
    listAccounts.mockResolvedValue([
      account("old", "2026-10-22T05:00:00.000Z"),
      account("new", "2026-11-01T05:00:00.000Z"),
    ]);
    listRange.mockResolvedValue({
      transactions: [n("old", "n1"), n("new", "n1"), n("old", "n2"), n("new", "n2")],
      categorisations: [],
    });

    const found = await recordAccountRenames(deps, "frost", NOW);

    expect(found.map((r) => r.supersededId)).toEqual(["old"]);
  });

  it("ignores an account row carrying no account id", async () => {
    listAccounts.mockResolvedValue([
      { lastSyncedAt: "2026-11-01T05:00:00.000Z" },
      account("new", "2026-11-01T05:00:00.000Z"),
    ]);
    listRange.mockResolvedValue({ transactions: [], categorisations: [] });

    expect(await recordAccountRenames(deps, "frost", NOW)).toEqual([]);
    expect(stillReturned([{ lastSyncedAt: "2026-11-01T05:00:00.000Z" }])).toEqual(
      new Set(),
    );
  });

  it("treats an empty link as no link, so a blanked field undoes a rename", async () => {
    // Reversibility is the whole reason this is one field. Clearing it to an
    // empty string has to read the same as removing it.
    listAccounts.mockResolvedValue([
      account("old", "2026-10-22T05:00:00.000Z", { supersededBy: "" }),
      account("new", "2026-11-01T05:00:00.000Z"),
    ]);
    listRange.mockResolvedValue({
      transactions: [txn("old", "p1"), txn("new", "p1"), txn("old", "p2"), txn("new", "p2")],
      categorisations: [],
    });

    const found = await recordAccountRenames(deps, "frost", NOW);

    expect(found.map((r) => r.supersededId)).toEqual(["old"]);
  });

  it("tolerates rows missing the fields the evidence reads", async () => {
    // Read-boundary tolerance, as everywhere else: one malformed row must not
    // stop the household's accounts being reconciled.
    listAccounts.mockResolvedValue([account("a", "2026-11-01T05:00:00.000Z")]);
    listRange.mockResolvedValue({
      transactions: [{ accountId: "a" }, {}],
      categorisations: [],
    });

    await expect(recordAccountRenames(deps, "frost", NOW)).resolves.toEqual([]);
  });
});
