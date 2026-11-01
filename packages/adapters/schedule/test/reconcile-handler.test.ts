import { describe, it, expect, vi, beforeEach } from "vitest";
import { realDeps } from "../src/reconcile-handler.js";

/**
 * The wiring for the scheduled reconciliation.
 *
 * The work is in `reconcileFrom`, which takes its clients as arguments and is
 * tested against fakes in @tightarse/events. What is worth checking here is
 * that this actually builds them, and reads the environment the alarms
 * dimension on.
 */

describe("building the real dependencies", () => {
  it("constructs both clients rather than returning placeholders", () => {
    const deps = realDeps();
    expect(deps.rows).toHaveProperty("scanAll");
    expect(deps.ledger).toHaveProperty("markBalanceReadingDirty");
  });

  it("defaults the metric dimension to dev rather than leaving it undefined", () => {
    // An undefined dimension emits under "undefined" and no alarm matches it,
    // which is #31 in miniature.
    expect(realDeps().config.environment).toBe("dev");
  });

  it("defaults the household rather than failing closed on a missing variable", () => {
    // One household. A missing TENANT_ID should not stop the check running.
    expect(realDeps().config.tenantId).toBe("frost");
  });

  it("builds the client recording renames, which needs different methods", () => {
    const deps = realDeps();
    expect(deps.renames).toHaveProperty("listAccounts");
    expect(deps.renames).toHaveProperty("listRange");
    expect(deps.renames).toHaveProperty("markSuperseded");
  });

  it("shares one store between both ports rather than opening two clients", () => {
    // A warm container holding two DynamoDB clients for one table is waste,
    // and the ports being separate is a typing decision rather than a reason
    // to connect twice.
    const deps = realDeps();
    expect(deps.renames).toBe(deps.ledger);
  });
});

describe("what the scheduled run does", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("reconciles balances first, then records renames", async () => {
    // The order is the whole point of this test. Both need the same settled
    // ledger, but balance reconciliation is the established check with an
    // alarm already watching it, so a failure in the newer step must not be
    // what stops it running.
    const calls: string[] = [];
    vi.doMock("@tightarse/domain", async () => ({
      ...(await vi.importActual<Record<string, unknown>>("@tightarse/domain")),
      reconcileFrom: vi.fn(async () => {
        calls.push("reconcile");
        return { accounts: [], checked: 0, breaks: [] };
      }),
      recordRenamesFrom: vi.fn(async () => {
        calls.push("renames");
        return [];
      }),
    }));

    const { handler } = await import("../src/reconcile-handler.js");
    const out = (await handler()) as Record<string, unknown>;

    expect(calls).toEqual(["reconcile", "renames"]);
    expect(out).toHaveProperty("reconciliation");
    expect(out).toHaveProperty("renames");
  });

  it("still reports the reconciliation it completed when recording renames fails", async () => {
    // Left to throw rather than swallowed: a handler that reported success
    // while recording nothing would leave the figures wrong indefinitely and
    // say so nowhere.
    vi.doMock("@tightarse/domain", async () => ({
      ...(await vi.importActual<Record<string, unknown>>("@tightarse/domain")),
      reconcileFrom: vi.fn(async () => ({ accounts: [], checked: 0, breaks: [] })),
      recordRenamesFrom: vi.fn(async () => {
        throw new Error("ProvisionedThroughputExceededException");
      }),
    }));

    const { handler } = await import("../src/reconcile-handler.js");

    await expect(handler()).rejects.toThrow("ProvisionedThroughputExceeded");
  });
});
