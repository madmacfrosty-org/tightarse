import { describe, it, expect } from "vitest";
import {
  currentAccounts,
  detectRenames,
  overlaps,
  resolveAccountId,
  resolvedAccountIds,
  sharedIdentities,
  transactionIdentity,
  type ComparableTransaction,
} from "../src/index.js";

/**
 * Recognising an account the provider has renamed.
 *
 * The thing being guarded against is not a missing feature but a wrong merge.
 * Joining two accounts a household really holds would double nothing and hide
 * everything: one card's transactions filed under another, a total that looks
 * entirely plausible, and no way to tell from the figures that it happened. So
 * most of what follows is about refusing.
 *
 * The real case these came from: two cards replaced in October 2026, 86 and 6
 * shared transactions, and one further card at the same provider that must not
 * be touched. #199.
 */

const tx = (
  accountId: string,
  providerTransactionId: string,
  over: Partial<ComparableTransaction> = {},
): ComparableTransaction => ({
  accountId,
  timestamp: "2026-10-01T00:00:00.000Z",
  amount: -1234,
  description: "a purchase",
  providerTransactionId,
  ...over,
});

describe("naming a transaction without its account", () => {
  it("gives the same transaction under two account ids one identity", () => {
    // The whole basis of the thing. The provider returns the same transaction
    // under both ids with the same id of its own, and that is the provider
    // telling us these are the same transaction.
    expect(transactionIdentity(tx("old", "p1"))).toBe(
      transactionIdentity(tx("new", "p1")),
    );
  });

  it("keeps two genuine charges apart, so a double charge is never collapsed", () => {
    // Identical date, amount and description, different provider ids: somebody
    // was charged twice and both charges are real. A ledger that merged these
    // would be worse than one that showed a duplicate.
    expect(transactionIdentity(tx("a", "p1"))).not.toBe(
      transactionIdentity(tx("a", "p2")),
    );
  });

  it("separates a reused provider id by its content", () => {
    // `dedupKey`'s own notes record the provider reusing ids across card
    // transactions with entirely different amounts.
    expect(transactionIdentity(tx("a", "p1"))).not.toBe(
      transactionIdentity(tx("a", "p1", { amount: -99 })),
    );
  });

  it("prefers the normalised identifier when both are present", () => {
    const withBoth = transactionIdentity({
      ...tx("a", "p1"),
      normalisedProviderTransactionId: "n1",
    });
    expect(withBoth.startsWith("n:")).toBe(true);
    expect(withBoth).not.toBe(transactionIdentity(tx("a", "p1")));
  });

  it("falls back to content alone when the provider supplies no identifier", () => {
    // No account id: `transactionIdentity` does not accept one, which is the
    // point of it — the signature is what stops the account creeping back in.
    const bare = transactionIdentity({
      timestamp: "2026-10-01T00:00:00.000Z",
      amount: -1,
      description: "x",
    });
    expect(bare.startsWith("c:")).toBe(true);
  });
});

describe("which account ids hold a transaction in common", () => {
  it("reports only identities held by more than one account", () => {
    const shared = sharedIdentities([
      tx("old", "p1"),
      tx("new", "p1"),
      tx("old", "p2"),
    ]);
    expect(shared.size).toBe(1);
    expect([...shared.values()][0]).toEqual(new Set(["old", "new"]));
  });

  it("finds nothing when every account's transactions are its own", () => {
    expect(sharedIdentities([tx("a", "p1"), tx("b", "p2")]).size).toBe(0);
  });

  it("counts each pair of ids separately when three share a transaction", () => {
    // Two renames in a chain. Each link needs its own count, or the second
    // rename is judged on the first one's evidence.
    const counted = overlaps([tx("a", "p1"), tx("b", "p1"), tx("c", "p1")]);
    expect([...counted.values()].map((o) => o.shared)).toEqual([1, 1, 1]);
    expect(counted.size).toBe(3);
  });

  it("accumulates across transactions for the same pair", () => {
    const counted = overlaps([
      tx("old", "p1"),
      tx("new", "p1"),
      tx("old", "p2"),
      tx("new", "p2"),
    ]);
    expect([...counted.values()]).toEqual([
      { a: "new", b: "old", shared: 2 },
    ]);
  });
});

describe("deciding that an account was renamed", () => {
  const accounts = [{ accountId: "old" }, { accountId: "new" }];
  const twoShared = [tx("old", "p1"), tx("new", "p1"), tx("old", "p2"), tx("new", "p2")];

  it("recognises the old id as superseded by the one still returned", () => {
    expect(
      detectRenames({ accounts, movements: twoShared, present: new Set(["new"]) }),
    ).toEqual([
      {
        supersededId: "old",
        survivingId: "new",
        evidence: { kind: "transaction-overlap", shared: 2 },
      },
    ]);
  });

  it("refuses when the provider returned both, however much they share", () => {
    // The guard that matters most. Two ids returned together are two accounts
    // the household holds at once — a pair showing both sides of an internal
    // transfer would otherwise be merged into one.
    expect(
      detectRenames({
        accounts,
        movements: twoShared,
        present: new Set(["old", "new"]),
      }),
    ).toEqual([]);
  });

  it("refuses when neither is returned any more", () => {
    // Both finished. Joining them changes no figure anybody is shown, so there
    // is nothing to gain and a guess to get wrong.
    expect(
      detectRenames({ accounts, movements: twoShared, present: new Set() }),
    ).toEqual([]);
  });

  it("refuses on a single shared transaction", () => {
    // One match can come from a reused provider id. Merging two real accounts
    // is far worse than leaving a rename unrecognised for another day.
    expect(
      detectRenames({
        accounts,
        movements: [tx("old", "p1"), tx("new", "p1")],
        present: new Set(["new"]),
      }),
    ).toEqual([]);
  });

  it("says nothing about an account already linked, so a sync can run it every time", () => {
    expect(
      detectRenames({
        accounts: [{ accountId: "old", supersededBy: "new" }, { accountId: "new" }],
        movements: twoShared,
        present: new Set(["new"]),
      }),
    ).toEqual([]);
  });

  it("ignores an id it holds no account row for", () => {
    // A transaction outlives the row naming it. That is not grounds to invent
    // an account and link it to something.
    expect(
      detectRenames({
        accounts: [{ accountId: "new" }],
        movements: twoShared,
        present: new Set(["new"]),
      }),
    ).toEqual([]);
  });

  it("leaves the third card at the same provider alone", () => {
    // The live case: two cards replaced, one untouched, nothing shared with it.
    const found = detectRenames({
      accounts: [{ accountId: "old" }, { accountId: "new" }, { accountId: "other" }],
      movements: [...twoShared, tx("other", "p9"), tx("other", "p8")],
      present: new Set(["new", "other"]),
    });
    expect(found.map((r) => r.supersededId)).toEqual(["old"]);
  });

  it("reports renames in a stable order", () => {
    const found = detectRenames({
      accounts: [
        { accountId: "b-old" },
        { accountId: "a-old" },
        { accountId: "live" },
      ],
      movements: [
        tx("b-old", "p1"),
        tx("live", "p1"),
        tx("b-old", "p2"),
        tx("live", "p2"),
        tx("a-old", "p3"),
        tx("live", "p3"),
        tx("a-old", "p4"),
        tx("live", "p4"),
      ],
      present: new Set(["live"]),
    });
    expect(found.map((r) => r.supersededId)).toEqual(["a-old", "b-old"]);
  });
});

describe("reading an account id after a rename", () => {
  it("resolves the old id to the one in use", () => {
    const ids = resolvedAccountIds([
      { accountId: "old", supersededBy: "new" },
      { accountId: "new" },
    ]);
    expect(resolveAccountId(ids, "old")).toBe("new");
    expect(resolveAccountId(ids, "new")).toBe("new");
  });

  it("follows a chain to its end, so an account renamed twice reads as one", () => {
    const ids = resolvedAccountIds([
      { accountId: "first", supersededBy: "second" },
      { accountId: "second", supersededBy: "third" },
      { accountId: "third" },
    ]);
    expect(resolveAccountId(ids, "first")).toBe("third");
    expect(resolveAccountId(ids, "second")).toBe("third");
  });

  it("passes an unknown id straight through rather than dropping its money", () => {
    const ids = resolvedAccountIds([{ accountId: "a" }]);
    expect(resolveAccountId(ids, "never-seen")).toBe("never-seen");
  });

  it("ignores a row claiming to supersede itself", () => {
    const ids = resolvedAccountIds([{ accountId: "a", supersededBy: "a" }]);
    expect(resolveAccountId(ids, "a")).toBe("a");
  });

  it("stops on a cycle rather than hanging", () => {
    // Only a bad write produces this. A wrong figure is bad; a dashboard that
    // never loads is worse, and the loop is visible in the data either way.
    const ids = resolvedAccountIds([
      { accountId: "a", supersededBy: "b" },
      { accountId: "b", supersededBy: "a" },
    ]);
    expect(["a", "b"]).toContain(resolveAccountId(ids, "a"));
  });
});

describe("the accounts a household still has", () => {
  it("drops the one that was renamed", () => {
    expect(
      currentAccounts([
        { accountId: "old", supersededBy: "new" },
        { accountId: "new" },
      ]).map((a) => a.accountId),
    ).toEqual(["new"]);
  });

  it("keeps everything when nothing has been renamed", () => {
    expect(
      currentAccounts([{ accountId: "a" }, { accountId: "b" }]).map((a) => a.accountId),
    ).toEqual(["a", "b"]);
  });

  it("keeps only the end of a chain", () => {
    expect(
      currentAccounts([
        { accountId: "first", supersededBy: "second" },
        { accountId: "second", supersededBy: "third" },
        { accountId: "third" },
      ]).map((a) => a.accountId),
    ).toEqual(["third"]);
  });
});
