import { gzipSync } from "node:zlib";
import { describe, it, expect, vi } from "vitest";
import { transformObject, type TransformDeps } from "./transform";

/**
 * Whether a settled transaction arrived with a running balance.
 *
 * The running balance on each transaction is the primary balance data — a
 * balance endpoint returns a point-in-time snapshot and cannot say how the
 * position moved, which is what the household is actually asking. So a settled
 * row without one is a gap in the series, and #30 is the decision to observe
 * that rather than reconstruct it.
 */

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
  running_balance: { currency: "GBP", amount: 100.0 },
  ...over,
});

/** A raw object key, in the partitioned form the landing zone writes. */
const keyFor = (dataset: string, account = "acc-1") =>
  `tenant=frost/dataset=${dataset}/account=${account}/2026-03-15T00:00:00Z.json.gz`;

function deps(results: unknown[]): { deps: TransformDeps; putTransactions: ReturnType<typeof vi.fn> } {
  const putTransactions = vi.fn(async () => {});
  const envelope = {
    captureVersion: 1,
    endpoint: "/x",
    accountId: "acc-1",
    fetchedAt: "2026-03-15T00:00:00Z",
    httpStatus: 200,
    body: { results },
  };
  return {
    putTransactions,
    deps: {
      bucket: "raw",
      // Uncompressed JSON: readObject sniffs the gzip magic bytes rather than
      // trusting the header, so a plain body is a valid object to it.
      raw: {

        get: async () => new TextEncoder().encode(JSON.stringify(envelope)),

        put: async () => {},

        list: async () => [],

      },
      ledger: {
        putTransactions,
        replacePending: vi.fn(async () => {}),
        putAccount: vi.fn(async () => {}),
        putBalances: vi.fn(async () => {}),
        putBalanceReading: vi.fn(async () => {}),
      },
    } as unknown as TransformDeps,
  };
}

describe("settled transactions with no running balance", () => {
  it("counts a card row that arrived without one, against the card", async () => {
    // Split by card because that is the question the provider's documentation
    // does not answer: running_balance is optional on both endpoints with no
    // documented rule, so which of ours omit it is a matter of observation. A
    // single total would say something is wrong without saying where.
    const r = await transformObject(
      deps([txn({ running_balance: undefined })]).deps,
      keyFor("truelayer.card_transactions"),
    );
    expect(r.unanchored).toEqual({ card: 1, account: 0 });
  });

  it("counts an account row against the account", async () => {
    const r = await transformObject(
      deps([txn({ running_balance: undefined })]).deps,
      keyFor("truelayer.transactions"),
    );
    expect(r.unanchored).toEqual({ card: 0, account: 1 });
  });

  it("reports zero when every settled row carries one", async () => {
    // Zero rather than absent: the metric is emitted for settled objects, and a
    // run that emits nothing at all is indistinguishable from a run that did
    // not happen.
    const r = await transformObject(deps([txn(), txn({ transaction_id: "tx-2" })]).deps, keyFor("truelayer.transactions"));
    expect(r.unanchored).toEqual({ card: 0, account: 0 });
  });

  it("counts only the rows that are missing one, not the whole object", async () => {
    const r = await transformObject(
      deps([txn(), txn({ transaction_id: "tx-2", running_balance: undefined }), txn({ transaction_id: "tx-3" })]).deps,
      keyFor("truelayer.transactions"),
    );
    expect(r.unanchored).toEqual({ card: 0, account: 1 });
    expect(r.rows).toBe(3);
  });

  it("does not count pending rows, which carry none by nature", async () => {
    // A pending transaction has no settled position to report yet, and arrives
    // on its own endpoint. Counting them would alarm every single sync.
    const r = await transformObject(
      deps([txn({ running_balance: undefined })]).deps,
      keyFor("truelayer.transactions_pending"),
    );
    expect(r.unanchored).toBeUndefined();
  });

  it("does not count pending card rows either", async () => {
    const r = await transformObject(
      deps([txn({ running_balance: undefined })]).deps,
      keyFor("truelayer.card_transactions_pending"),
    );
    expect(r.unanchored).toBeUndefined();
  });

  it("says nothing at all for an object that is not transactions", async () => {
    // Absent rather than zero, so "nothing to count" and "counted nothing" stay
    // distinguishable — a balance object could never have carried one.
    const r = await transformObject(
      deps([{ current: 100, available: 100, currency: "GBP" }]).deps,
      keyFor("truelayer.balance"),
    );
    expect(r.unanchored).toBeUndefined();
  });
});

/**
 * The rest of transformObject, which had no tests at all before this. Adding
 * the first test for a file pulls its branches into the denominator, so
 * covering only the new counting would have lowered the package's branch
 * coverage while appearing to improve things.
 */
describe("normalising the running balance at the boundary", () => {
  // The seam between the dataset and the mapper. mapTransaction gets card-ness
  // right on its own; this is about transform.ts actually telling it, which a
  // test of the mapper alone cannot see.
  const captured = async (dataset: string) => {
    const put = vi.fn(async (_rows: Array<Record<string, unknown>>) => {});
    const d = deps([txn({ running_balance: { currency: "GBP", amount: 2000 } })]);
    (d.deps as any).ledger.putTransactions = put;
    await transformObject(d.deps, keyFor(dataset));
    return put.mock.calls[0]![0][0]!;
  };

  it("negates it for a card, because the card endpoint is what says so", async () => {
    // A positive running balance on a card is money OWED. Left as the provider
    // sends it, a £2,000 card debt and £2,000 of savings are the same number.
    expect((await captured("truelayer.card_transactions"))["runningBalance"]).toBe(-200_000);
  });

  it("leaves it alone for an account", async () => {
    expect((await captured("truelayer.transactions"))["runningBalance"]).toBe(200_000);
  });

  it("signs the amount identically either way", async () => {
    // The guard, at this level too: only runningBalance may depend on the
    // endpoint. amount comes from transaction_type and must not move.
    const card = await captured("truelayer.card_transactions");
    const account = await captured("truelayer.transactions");
    expect(card["amount"]).toBe(account["amount"]);
  });
});

describe("routing a raw object to the right handler", () => {
  it("writes accounts through putAccount, marking cards from the dataset", async () => {
    // Card-ness comes from which endpoint answered, because no field in the
    // payload reliably says so.
    const putAccount = vi.fn(async (_account: unknown) => {});
    const d = deps([{ account_id: "acc-1", display_name: "Gold", currency: "GBP" }]);
    (d.deps as any).ledger.putAccount = putAccount;
    const r = await transformObject(d.deps, keyFor("truelayer.cards"));
    expect(r.handler).toBe("accounts");
    expect(putAccount).toHaveBeenCalledTimes(1);
    expect(putAccount.mock.calls[0]![0]).toMatchObject({ isCard: true });
  });

  it("keeps the balance reading as well as the latest figure", async () => {
    // putBalances overwrites, so the ledger held one balance per account and
    // there was nothing to reconcile against. The reading is what makes a
    // series, and it is the only check that covers cards.
    const putBalanceReading = vi.fn(async (_r: unknown) => {});
    const d = deps([{ current: 181.44, available: 556.15, currency: "GBP" }]);
    (d.deps as any).ledger.putBalanceReading = putBalanceReading;
    await transformObject(d.deps, keyFor("truelayer.card_balance"));
    expect(putBalanceReading).toHaveBeenCalledTimes(1);
    // Negated, because a positive card balance is money owed.
    expect(putBalanceReading.mock.calls[0]![0]).toMatchObject({
      accountId: "acc-1",
      balance: -18_144,
      fetchedAt: "2026-03-15T00:00:00Z",
    });
  });

  it("writes a balance without touching the account's identity", async () => {
    // putBalances only, because upserting a whole account here once invented
    // placeholders that overwrote real details fetched moments earlier.
    const putBalances = vi.fn(async () => {});
    const d = deps([{ current: 100, available: 90, currency: "GBP" }]);
    (d.deps as any).ledger.putBalances = putBalances;
    const r = await transformObject(d.deps, keyFor("truelayer.balance"));
    expect(r.handler).toBe("balance");
    expect(putBalances).toHaveBeenCalledTimes(1);
  });

  it("records card-ness on the balance path, so a row it creates is readable", async () => {
    // A balance can arrive before the account details, and putBalances creates
    // the row when it does. Without isCard that row carries a figure with no
    // way to tell whether it is money held or money owed, and the dashboard
    // read the absence as a definite "not a card" — overstating the position by
    // twice the balance whenever it was a card (#29).
    //
    // This is not a placeholder. It comes from which endpoint returned the
    // data, the same source the accounts path uses, so the two cannot disagree.
    const putBalances = vi.fn(async () => {});
    const card = deps([{ current: 100, available: 90, currency: "GBP" }]);
    (card.deps as any).ledger.putBalances = putBalances;
    await transformObject(card.deps, keyFor("truelayer.card_balance"));
    expect(putBalances).toHaveBeenCalledWith("frost", "acc-1", expect.objectContaining({ isCard: true }));

    const current = deps([{ current: 100, available: 90, currency: "GBP" }]);
    (current.deps as any).ledger.putBalances = putBalances;
    await transformObject(current.deps, keyFor("truelayer.balance"));
    // Explicitly false, not absent — "not a card" is an answer and the
    // dashboard has to be able to tell it from "not known yet".
    expect(putBalances).toHaveBeenLastCalledWith("frost", "acc-1", expect.objectContaining({ isCard: false }));
  });

  it("replaces the pending set rather than merging it", async () => {
    // An empty result means everything cleared, which is normal and must delete
    // the previous set.
    const replacePending = vi.fn(async () => {});
    const d = deps([]);
    (d.deps as any).ledger.replacePending = replacePending;
    const r = await transformObject(d.deps, keyFor("truelayer.transactions_pending"));
    expect(replacePending).toHaveBeenCalledWith("frost", "acc-1", []);
    expect(r.rows).toBe(0);
  });

  it("does nothing for a dataset we deliberately ignore", async () => {
    const r = await transformObject(deps([{ anything: true }]).deps, keyFor("truelayer.info"));
    expect(r).toMatchObject({ handler: "ignore", rows: 0 });
  });

  it("refuses to write rows from a non-2xx response body", async () => {
    // These should not be in the landing zone at all, but a fetcher change
    // could put them there, and an error body is not data.
    const d = deps([]);
    (d.deps as any).raw = {
      get: async () => new TextEncoder().encode(
        JSON.stringify({ captureVersion: 1, endpoint: "/x", accountId: "acc-1", fetchedAt: "x", httpStatus: 429, body: {} }),
      ),
      put: async () => {},
      list: async () => [],
    };
    await expect(transformObject(d.deps, keyFor("truelayer.transactions"))).rejects.toThrow(/non-2xx/);
  });

  it("falls back to the envelope's account when the key does not name one", async () => {
    // Not every key carries account=. The envelope records which account the
    // response was for, and using it means an object written under an older key
    // layout still transforms.
    const key = "tenant=frost/dataset=truelayer.transactions/2026-03-15T00:00:00Z.json.gz";
    const r = await transformObject(deps([txn()]).deps, key);
    expect(r.rows).toBe(1);
  });

  it("refuses transactions when neither the key nor the envelope names an account", async () => {
    // Writing rows with no account would attach them to nothing, and they
    // would then be invisible to every per-account query.
    const key = "tenant=frost/dataset=truelayer.transactions/2026-03-15T00:00:00Z.json.gz";
    const d = deps([txn()]);
    (d.deps as any).raw = {
      get: async () => new TextEncoder().encode(
        JSON.stringify({ captureVersion: 1, endpoint: "/x", accountId: null, fetchedAt: "x", httpStatus: 200, body: { results: [txn()] } }),
      ),
      put: async () => {},
      list: async () => [],
    };
    await expect(transformObject(d.deps, key)).rejects.toThrow(/no account/);
  });
});

describe("reading a raw object", () => {
  const envelope = (body: unknown) => ({
    captureVersion: 1,
    endpoint: "/x",
    accountId: "acc-1",
    fetchedAt: "2026-03-15T00:00:00Z",
    httpStatus: 200,
    body,
  });

  const withBody = (bytes: Uint8Array | undefined): TransformDeps =>
    ({
      bucket: "raw",
      raw: {
        get: async () => bytes ?? new Uint8Array(),
        put: async () => {},
        list: async () => [],
      },
      ledger: { putTransactions: vi.fn(async () => {}) },
    }) as unknown as TransformDeps;

  it("decompresses a gzipped object, which is what the landing zone actually writes", async () => {
    // The uploader gzips and S3 does not decompress on read, so every real
    // object takes this path — and it was the one branch no test exercised.
    const bytes = gzipSync(Buffer.from(JSON.stringify(envelope({ results: [txn()] }))));
    const r = await transformObject(withBody(new Uint8Array(bytes)), keyFor("truelayer.transactions"));
    expect(r.rows).toBe(1);
  });

  it("refuses an empty object rather than treating it as no rows", async () => {
    // Zero rows and "the object did not download" are different, and only one
    // of them should be silent.
    await expect(
      transformObject(withBody(undefined), keyFor("truelayer.transactions")),
    ).rejects.toThrow(/Empty object/);
  });

  it("treats a response with no results as no rows", async () => {
    // A body with no results array is a valid empty answer from the provider.
    const bytes = new TextEncoder().encode(JSON.stringify(envelope({})));
    const r = await transformObject(withBody(bytes), keyFor("truelayer.transactions"));
    expect(r.rows).toBe(0);
    expect(r.unanchored).toEqual({ card: 0, account: 0 });
  });
});
