import { describe, it, expect, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { keyMatchesDatasets, listRawKeys, replay, type ReplayDeps } from "../src/backfill";

/**
 * Replaying the raw landing zone.
 *
 * This is the mechanism that makes the landing zone's central claim true — that
 * the ledger can always be rebuilt. Until now it had no tests at all, which
 * made that claim rather than a demonstration.
 */

const envelope = (results: unknown[], accountId: string | null = "acc-1") => ({
  captureVersion: 1,
  endpoint: "/x",
  accountId,
  fetchedAt: "2026-03-15T00:00:00Z",
  httpStatus: 200,
  body: { results },
});

const txn = (over: Record<string, unknown> = {}) => ({
  timestamp: "2026-03-15T00:00:00Z",
  description: "SHOP",
  transaction_type: "DEBIT",
  transaction_category: "PURCHASE",
  transaction_classification: [],
  amount: 12.99,
  currency: "GBP",
  transaction_id: "tx-1",
  provider_transaction_id: "ptx-1",
  running_balance: { currency: "GBP", amount: 100 },
  ...over,
});

/**
 * A ledger that records final state rather than calls.
 *
 * Calls would only prove what happened in what order; the property worth
 * asserting is what the table ends up holding.
 */
function fakeLedger() {
  const transactions = new Map<string, unknown>();
  const accounts = new Map<string, Record<string, unknown>>();
  const pending = new Map<string, unknown[]>();
  const readings = new Map<string, unknown>();
  return {
    state: { transactions, accounts, pending, readings },
    ledger: {
      putTransactions: async (rows: Array<Record<string, unknown>>) => {
        for (const r of rows) transactions.set(String(r["dedupKey"] ?? r["transactionId"]), r);
      },
      putAccount: async (a: Record<string, unknown>) => {
        accounts.set(String(a["accountId"]), { ...(accounts.get(String(a["accountId"])) ?? {}), ...a });
      },
      // Mirrors the real putBalances, which renames current -> currentBalance
      // and writes only what is defined. A fake that stored the argument
      // verbatim would agree with itself and prove nothing about the ledger.
      putBalances: async (
        _t: string,
        accountId: string,
        b: { current?: number; available?: number; currency?: string },
      ) => {
        const merged: Record<string, unknown> = { ...(accounts.get(accountId) ?? {}), accountId };
        if (b.current !== undefined) merged["currentBalance"] = b.current;
        if (b.available !== undefined) merged["availableBalance"] = b.available;
        if (b.currency !== undefined) merged["currency"] = b.currency;
        accounts.set(accountId, merged);
      },
      replacePending: async (_t: string, accountId: string, rows: unknown[]) => {
        pending.set(accountId, rows);
      },
      putBalanceReading: async (r: Record<string, unknown>) => {
        readings.set(`${String(r["accountId"])}|${String(r["fetchedAt"])}`, r);
      },
    },
  };
}

/** An S3 that serves a fixed set of keys and bodies, with pagination. */
function fakeRaw(objects: Record<string, unknown>) {
  // Smaller than the client it replaces: the port has three methods, so the fake
  // has three, and pagination is the adapter's problem rather than every test's.
  return {
    get: async (key: string) => {
      const body = objects[key];
      if (body === undefined) throw new Error(`NoSuchKey: ${key}`);
      return new Uint8Array(gzipSync(Buffer.from(JSON.stringify(body))));
    },
    put: async () => {},
    list: async (prefix: string) => Object.keys(objects).filter((k) => k.startsWith(prefix)),
  };
}

const deps = (objects: Record<string, unknown>, pageSize?: number) => {
  const { ledger, state } = fakeLedger();
  return {
    state,
    deps: { raw: fakeRaw(objects), ledger, bucket: "raw" } as unknown as ReplayDeps,
  };
};

const key = (dataset: string, account = "acc-1", stamp = "20260315T000000") =>
  `tenant=frost/dataset=${dataset}/account=${account}/${stamp}-abc123def456.json.gz`;

describe("finding the objects to replay", () => {
  it("follows pagination to the end rather than stopping at the first page", async () => {
    // Five years of syncs is well past one page. Stopping early would replay a
    // prefix of the landing zone and report success.
    const objects = Object.fromEntries(
      Array.from({ length: 250 }, (_, i) => [key("truelayer.transactions", "acc-1", `2026031${i}`), envelope([])]),
    );
    const { deps: d } = deps(objects, 100);
    expect(await listRawKeys(d, "frost")).toHaveLength(250);
  });

  it("asks only for the tenant's own prefix", async () => {
    // One household's replay must never read another's raw objects.

    const list = vi.fn(async () => [] as string[]);

    await listRawKeys({ raw: { list } } as unknown as ReplayDeps, "frost");

    expect(list).toHaveBeenCalledWith("tenant=frost/");
  });
});

describe("replaying", () => {
  it("writes the rows the raw objects describe", async () => {
    const { deps: d, state } = deps({
      [key("truelayer.transactions")]: envelope([txn(), txn({ transaction_id: "tx-2", provider_transaction_id: "ptx-2" })]),
    });
    const result = await replay(d, { tenantId: "frost", log: () => {} });
    expect(result.objects).toBe(1);
    expect(result.rows).toBe(2);
    expect(state.transactions.size).toBe(2);
  });

  it("writes nothing on a dry run", async () => {
    // The point of the flag: see what would happen before doing it to a table.
    const { deps: d, state } = deps({ [key("truelayer.transactions")]: envelope([txn()]) });
    const result = await replay(d, { tenantId: "frost", dryRun: true, log: () => {} });
    expect(result.objects).toBe(1);
    expect(result.rows).toBe(0);
    expect(state.transactions.size).toBe(0);
  });

  it("keeps going after a bad object and reports it", async () => {
    // One unreadable object must not hide what the other two hundred did. A
    // partial replay you know the shape of beats a stack trace.
    const { deps: d, state } = deps({
      [key("truelayer.transactions", "acc-1", "20260101T000000")]: envelope([txn()]),
      [key("truelayer.transactions", "acc-1", "20260201T000000")]: { httpStatus: 500, body: {} },
      [key("truelayer.transactions", "acc-1", "20260301T000000")]: envelope([txn({ transaction_id: "tx-3", provider_transaction_id: "ptx-3" })]),
    });
    const result = await replay(d, { tenantId: "frost", log: () => {} });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.key).toContain("20260201");
    expect(state.transactions.size).toBe(2);
  });

  it("counts rows by handler, so a replay can be read at a glance", async () => {
    const { deps: d } = deps({
      [key("truelayer.transactions")]: envelope([txn()]),
      [key("truelayer.accounts", "acc-1")]: envelope([{ account_id: "acc-1", display_name: "Current", currency: "GBP" }]),
    });
    const result = await replay(d, { tenantId: "frost", log: () => {} });
    expect(result.byHandler).toMatchObject({ settled: 1, accounts: 1 });
  });
});

describe("order independence", () => {
  it("converges to the same accounts whichever order the objects arrive in", async () => {
    // The property the old comment claimed and the key order never provided:
    // `dataset=truelayer.card_balance` sorts before `dataset=truelayer.cards`,
    // so card balances have always been written before the card that owns them.
    // It does not matter, and this is what says so.
    const objects: Record<string, unknown> = {
      [key("truelayer.cards", "card-1")]: envelope([{ account_id: "card-1", display_name: "Gold", currency: "GBP" }], "card-1"),
      [key("truelayer.card_balance", "card-1")]: envelope([{ current: 181.44, available: 556.15, currency: "GBP" }], "card-1"),
    };

    const forwards = deps(objects);
    await replay(forwards.deps, { tenantId: "frost", log: () => {} });

    const backwards = deps(Object.fromEntries(Object.entries(objects).reverse()));
    await replay(backwards.deps, { tenantId: "frost", log: () => {} });

    expect(Object.fromEntries(backwards.state.accounts)).toEqual(
      Object.fromEntries(forwards.state.accounts),
    );
    // And the result is right either way: identity from the card list, balances
    // from the balance object, both present.
    const account = forwards.state.accounts.get("card-1")!;
    expect(account["isCard"]).toBe(true);
    expect(account["currentBalance"]).toBe(18144);
  });

  it("converges to the same transactions whichever order they arrive in", async () => {
    // Idempotent puts keyed by dedupKey, so this is a property rather than a
    // coincidence — and it is what allows a replay to be parallelised later.
    const objects: Record<string, unknown> = {
      [key("truelayer.transactions", "acc-1", "20260101T000000")]: envelope([txn()]),
      [key("truelayer.transactions", "acc-1", "20260201T000000")]: envelope([txn({ transaction_id: "tx-2", provider_transaction_id: "ptx-2" })]),
      [key("truelayer.transactions", "acc-1", "20260301T000000")]: envelope([txn({ transaction_id: "tx-3", provider_transaction_id: "ptx-3" })]),
    };
    const forwards = deps(objects);
    await replay(forwards.deps, { tenantId: "frost", log: () => {} });
    const backwards = deps(Object.fromEntries(Object.entries(objects).reverse()));
    await replay(backwards.deps, { tenantId: "frost", log: () => {} });

    expect([...backwards.state.transactions.keys()].sort()).toEqual(
      [...forwards.state.transactions.keys()].sort(),
    );
  });

  it("does NOT converge for pending, which is why that one is worth knowing about", async () => {
    // replacePending replaces a whole set, so the last object replayed wins.
    // This does not matter today only because nothing reads pending rows. If
    // that changes, this test is the reminder. See #35.
    const objects: Record<string, unknown> = {
      [key("truelayer.transactions_pending", "acc-1", "20260101T000000")]: envelope([txn({ transaction_id: "old" })]),
      [key("truelayer.transactions_pending", "acc-1", "20260201T000000")]: envelope([
        txn({ transaction_id: "new-1" }),
        txn({ transaction_id: "new-2" }),
      ]),
    };
    const forwards = deps(objects);
    await replay(forwards.deps, { tenantId: "frost", log: () => {} });
    const backwards = deps(Object.fromEntries(Object.entries(objects).reverse()));
    await replay(backwards.deps, { tenantId: "frost", log: () => {} });

    expect(forwards.state.pending.get("acc-1")).toHaveLength(2);
    expect(backwards.state.pending.get("acc-1")).toHaveLength(1);
  });
});

describe("edges worth not crashing on", () => {

  it("writes to the console when given no writer, which is what the command line does", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { deps: d } = deps({ [key("truelayer.transactions")]: envelope([txn()]) });
    await replay(d, { tenantId: "frost" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("reports a thrown non-Error without losing the object it came from", async () => {
    // Anything can be thrown in JavaScript. Losing the key would leave a
    // failure count with nothing to investigate.
    const d = {
      raw: {

        list: async () => [key("truelayer.transactions")],

        get: async () => {

          throw "a string, not an Error";

        },

      },
      ledger: {},
      bucket: "raw",
    } as unknown as ReplayDeps;
    const result = await replay(d, { tenantId: "frost", log: () => {} });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.error).toContain("a string");
    expect(result.failures[0]!.key).toContain("truelayer.transactions");
  });
});

describe("replaying only some datasets", () => {
  it("matches on the whole path segment, so balance does not select card_balance", () => {
    // A substring match would sweep card balances into a balance-only replay
    // and write rows nobody asked for.
    const accountBalance = key("truelayer.balance");
    const cardBalance = key("truelayer.card_balance");
    expect(keyMatchesDatasets(accountBalance, ["truelayer.balance"])).toBe(true);
    expect(keyMatchesDatasets(cardBalance, ["truelayer.balance"])).toBe(false);
    expect(keyMatchesDatasets(cardBalance, ["truelayer.card_balance"])).toBe(true);
  });

  it("takes several datasets at once", () => {
    expect(keyMatchesDatasets(key("truelayer.card_balance"), ["truelayer.balance", "truelayer.card_balance"])).toBe(true);
  });

  it("replays everything when nothing is named", () => {
    // Against a fresh table there is no reason to filter, so the default is a
    // complete rebuild.
    expect(keyMatchesDatasets(key("truelayer.transactions"))).toBe(true);
    expect(keyMatchesDatasets(key("truelayer.transactions"), [])).toBe(true);
  });

  it("transforms only the matching objects", async () => {
    // The point of the filter: replaying everything into the live table would
    // rewrite ingestedAt on every transaction, which is stamped at write time
    // and is the record of when a row actually arrived.
    const { deps: d, state } = deps({
      [key("truelayer.transactions")]: envelope([txn()]),
      [key("truelayer.balance")]: envelope([{ current: 100, available: 90, currency: "GBP" }]),
    });
    const result = await replay(d, { tenantId: "frost", datasets: ["truelayer.balance"], log: () => {} });
    expect(result.objects).toBe(1);
    expect(state.transactions.size).toBe(0);
    expect(state.readings.size).toBe(1);
  });

  it("says how much of the landing zone it skipped", async () => {
    // A replay that quietly did a tenth of the work would look like a
    // successful rebuild.
    const lines: string[] = [];
    const { deps: d } = deps({
      [key("truelayer.transactions")]: envelope([txn()]),
      [key("truelayer.balance")]: envelope([{ current: 100, currency: "GBP" }]),
    });
    await replay(d, { tenantId: "frost", datasets: ["truelayer.balance"], log: (l) => lines.push(l) });
    expect(lines[0]).toContain("1 objects of 2, limited to truelayer.balance");
  });
});
