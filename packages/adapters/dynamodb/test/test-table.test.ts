import { describe, it, expect } from "vitest";
import { resolveTestTarget, CITEST_REGION, CITEST_TABLE_PREFIX } from "../src/test-table";

/**
 * These are about one outcome: an integration run must be incapable of reaching
 * the household ledger. The suites leave their rows behind by design, so
 * "pointed at the wrong table" and "wrote test data into five years of real
 * transactions" are the same event.
 */

const env = (over: Partial<Record<string, string>> = {}) => ({
  LEDGER_TEST_TABLE: `${CITEST_TABLE_PREFIX}run-1`,
  AWS_REGION: CITEST_REGION,
  ...over,
});

describe("choosing a table for an integration run", () => {
  it("refuses the live table's name on real DynamoDB", () => {
    // The old default. Ambient credentials, nothing set, and the script found
    // the real ledger and called it a success.
    expect(() => resolveTestTarget(env({ LEDGER_TEST_TABLE: "DynamoStore" }))).toThrow(/Refusing/);
  });

  it("refuses the region the ledger is in, even for a correctly named table", () => {
    // Both halves are load-bearing. A tightarse-citest-* table in eu-west-1 is
    // harmless in itself, but it means the run is authenticating against the
    // account and region where a mistyped name does damage.
    expect(() =>
      resolveTestTarget(env({ AWS_REGION: "eu-west-1" })),
    ).toThrow(/eu-west-1/);
  });

  it("refuses to guess a table name rather than defaulting to one", () => {
    // A default is what made this dangerous: the safe path needed you to know
    // to set something, and the unsafe path was the one you got by saying
    // nothing at all.
    expect(() => resolveTestTarget(env({ LEDGER_TEST_TABLE: undefined }))).toThrow(
      /LEDGER_TEST_TABLE is not set/,
    );
  });

  it("accepts a prefixed table in the test region", () => {
    expect(resolveTestTarget(env())).toEqual({
      tableName: `${CITEST_TABLE_PREFIX}run-1`,
      region: CITEST_REGION,
    });
  });

  it("does not hand back an endpoint when it resolved real DynamoDB", () => {
    // The client only supplies static local credentials when an endpoint is
    // present. Leaking one through here would make a real-AWS run authenticate
    // as "local" and fail as UnrecognizedClientException, which reads like a
    // credentials problem rather than a wiring one.
    expect(resolveTestTarget(env())).not.toHaveProperty("endpoint");
  });

  it("lets DynamoDB Local use any name, since it holds nothing", () => {
    // Local is wiped per run and reachable only from the machine it runs on,
    // so the prefix would buy nothing and would break the documented command.
    expect(
      resolveTestTarget({
        LEDGER_TEST_TABLE: "DynamoStore",
        LEDGER_TEST_ENDPOINT: "http://localhost:8000",
        AWS_REGION: "eu-west-1",
      }),
    ).toEqual({
      tableName: "DynamoStore",
      region: "eu-west-1",
      endpoint: "http://localhost:8000",
    });
  });

  it("falls back to the test region rather than to the ledger's", () => {
    // AWS_REGION is routinely unset on a laptop. Defaulting to eu-west-1 —
    // which is what the scripts used to do — puts the fallback in the one
    // region this is trying to stay out of.
    expect(resolveTestTarget(env({ AWS_REGION: undefined })).region).toBe(CITEST_REGION);
  });
});
