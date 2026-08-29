import { describe, it, expect } from "vitest";
import { RecordedTransaction } from "@tightarse/domain";
import { parseFacts } from "../src/parse.js";

/**
 * What the adapter does with a row it cannot read.
 *
 * The reads used to return `Record<string, unknown>`, so this question had no
 * single answer: each consumer coped, or did not, in its own way. Now there is
 * one place to ask it, so it is worth pinning what the answer is and why.
 *
 * Every value below is invented. This repository is public and the rows this
 * parses in production are a real household's.
 */

const stored = (
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  pk: "TENANT#t1",
  sk: "2026-03-15T00:00:00Z#n:1",
  kind: "TXN",
  tenantId: "t1",
  accountId: "acc1",
  transactionId: "txn-1",
  dedupKey: "n:1",
  timestamp: "2026-03-15T00:00:00Z",
  amount: -1299,
  currency: "GBP",
  description: "SHOP",
  status: "settled",
  transactionType: "DEBIT",
  ingestedAt: "2026-03-16T00:00:00Z",
  ...over,
});

describe("parseFacts", () => {
  it("returns domain values rather than table rows", () => {
    const [txn] = parseFacts(RecordedTransaction, [stored()], "transaction");

    expect(txn).toMatchObject({ dedupKey: "n:1", amount: -1299 });
    // The storage keys are gone. That is what parsing at the boundary buys: a
    // consumer cannot reach for `pk`, so it cannot come to depend on it.
    expect(txn).not.toHaveProperty("pk");
    expect(txn).not.toHaveProperty("kind");
  });

  it("refuses the whole read rather than dropping a fact", () => {
    // Dropping the bad row would not make the answer less precise, it would
    // make it wrong: the total comes out short and nothing downstream can tell
    // "you spent less" from "we could not read a row". Same choice as
    // assertSingleCurrency — an error rather than a plausible wrong number.
    expect(() =>
      parseFacts(
        RecordedTransaction,
        [stored(), stored({ amount: undefined })],
        "transaction",
      ),
    ).toThrow(/unreadable transaction row at index 1/);
  });

  it("names the field that was wrong without quoting the row", () => {
    let message = "";
    try {
      parseFacts(
        RecordedTransaction,
        [stored({ description: 42, dedupKey: "n:secret" })],
        "transaction",
      );
    } catch (e) {
      message = (e as Error).message;
    }

    expect(message).toMatch(/description/);
    // A parse failure has to be diagnosable from a log this project can
    // publish, so the offending value never appears in the message.
    expect(message).not.toMatch(/n:secret/);
  });

  it("lists every problem with the row, and where each one is", () => {
    // One field named and the rest swallowed would send whoever is holding the
    // pager back for a second read to find the next fault. The path matters as
    // much as the reason: `providerClassification.0` is a different repair from
    // `providerClassification`.
    let message = "";
    try {
      parseFacts(
        RecordedTransaction,
        [stored({ amount: "lots", providerClassification: [7] })],
        "transaction",
      );
    } catch (e) {
      message = (e as Error).message;
    }

    expect(message).toMatch(/amount:/);
    expect(message).toMatch(/providerClassification\.0:/);
    expect(message).toMatch(/;/);
  });

  it("reports a row that is not an object at all", () => {
    // No field path to name: the row itself is wrong, not one of its values.
    // Worth covering because this is what a scan returning a scalar looks like,
    // and "(root)" is the only clue the message can offer.
    expect(() =>
      parseFacts(RecordedTransaction, ["not a row"], "transaction"),
    ).toThrow(/unreadable transaction row at index 0: \(root\):/);
  });

  it("is happy with nothing to parse", () => {
    expect(parseFacts(RecordedTransaction, [], "transaction")).toEqual([]);
  });
});
