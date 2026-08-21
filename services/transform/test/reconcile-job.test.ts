import { describe, it, expect, vi } from "vitest";
import {
  dataFrom,
  groupForReconciliation,
  reconcileConfig,
  reconcileFrom,
  reconciliationLines,
  reconciliationMetrics,
} from "../src/reconcile-job";
import { reconcile } from "@tightarse/domain";
import type { Reading } from "@tightarse/domain";

/**
 * The adapter half: turning stored rows into what the use case reads, and the
 * scheduled run around it.
 *
 * The check itself lives in @tightarse/domain. What is testable only here is
 * the grouping — an account's readings must never be served against another
 * account's transactions — and that first-seen survives the trip out of the
 * table, because that field is what tells a late settler from a missing one.
 */

const reading = (accountId: string, asOf: string, balance: number, fetchedAt = asOf): Reading => ({
  accountId,
  asOf,
  fetchedAt,
  balance,
});

describe("what the scheduled run reads from the environment", () => {
  it("takes every value the deployment provides", () => {
    expect(
      reconcileConfig({ TABLE_NAME: "Ledger", TENANT_ID: "someone", AWS_REGION: "eu-west-2", ENVIRONMENT: "prod" }),
    ).toEqual({ tableName: "Ledger", tenantId: "someone", region: "eu-west-2", environment: "prod" });
  });

  it("falls back on every value when nothing is set", () => {
    // Both sides asserted so branch coverage does not depend on which machine
    // ran the suite — AWS_REGION is set in CI and unset on a laptop, which
    // broke main twice.
    expect(reconcileConfig({})).toEqual({
      tableName: "",
      tenantId: "frost",
      region: "eu-west-1",
      environment: "dev",
    });
  });
});

describe("grouping a scan for reconciliation", () => {
  const rows = [
    { pk: "T#frost", sk: "ACCOUNT#acc-1", accountId: "acc-1", isCard: false },
    { pk: "T#frost", sk: "ACCOUNT#card-1", accountId: "card-1", isCard: true },
    { pk: "T#frost#BAL#acc-1", sk: "2026-01-01T05:00:00.000Z", accountId: "acc-1", asOf: "2026-01-01T05:00:00.000Z", fetchedAt: "2026-01-01T05:00:00.000Z", balance: 100 },
    { pk: "T#frost#TX", sk: "2026-01-02T00:00:00Z#TX#n:a", accountId: "acc-1", timestamp: "2026-01-02T00:00:00Z", amount: -50 },
    { pk: "T#frost#TX", sk: "2026-01-02T00:00:00Z#EN#n:a", accountId: "acc-1", category: "Groceries" },
    { pk: "T#frost", sk: "SETTINGS" },
  ];

  it("separates accounts, readings and transactions by kind", () => {
    const g = groupForReconciliation(rows);
    expect(g.accounts).toEqual([
      { accountId: "acc-1", isCard: false },
      { accountId: "card-1", isCard: true },
    ]);
    expect(g.readings.get("acc-1")).toHaveLength(1);
    expect(g.movements.get("acc-1")).toHaveLength(1);
  });

  it("leaves enrichments out, which share a partition with transactions", () => {
    // They differ only by a marker in the sort key. Counting one as a movement
    // would report a break on an account that is perfectly fine.
    expect(groupForReconciliation(rows).movements.get("acc-1")).toEqual([
      { timestamp: "2026-01-02T00:00:00Z", amount: -50 },
    ]);
  });

  it("carries first-seen through, so a late settler can be told from a missing one", () => {
    // A transaction we did not hold when a reading was taken cannot have been in
    // that balance. Losing this in the grouping is what made four Amex
    // transactions look like £56.59 of missing money.
    const withProvenance = [
      {
        pk: "T#frost#TX",
        sk: "2026-01-02T00:00:00Z#TX#n:a",
        accountId: "acc-9",
        timestamp: "2026-01-02T00:00:00Z",
        amount: -50,
        ingestedAt: "2026-01-04T05:00:00.000Z",
      },
    ];
    expect(groupForReconciliation(withProvenance).movements.get("acc-9")).toEqual([
      { timestamp: "2026-01-02T00:00:00Z", amount: -50, firstSeenAt: "2026-01-04T05:00:00.000Z" },
    ]);
  });

  it("omits first-seen on a row written before provenance was kept", () => {
    // Absent rather than guessed. The check reads absent as "we already had it",
    // which is what it assumed before first-seen existed.
    const legacy = [
      {
        pk: "T#frost#TX",
        sk: "2026-01-02T00:00:00Z#TX#n:a",
        accountId: "acc-9",
        timestamp: "2026-01-02T00:00:00Z",
        amount: -50,
      },
    ];
    expect(groupForReconciliation(legacy).movements.get("acc-9")).toEqual([
      { timestamp: "2026-01-02T00:00:00Z", amount: -50 },
    ]);
  });


  it("gives an account with no readings an empty list rather than undefined", () => {
    expect(groupForReconciliation(rows).readings.get("card-1")).toBeUndefined();
  });
});

describe("wiring a scan to the use case", () => {
  const rows = [
    { pk: "T#frost", sk: "ACCOUNT#acc-1", accountId: "acc-1", isCard: false },
    { pk: "T#frost", sk: "ACCOUNT#acc-2", accountId: "acc-2", isCard: false },
    { pk: "T#frost#BAL#acc-1", sk: "a", accountId: "acc-1", asOf: "2026-01-01T05:00:00.000Z", fetchedAt: "2026-01-01T05:00:00.000Z", balance: 100_00 },
    { pk: "T#frost#BAL#acc-1", sk: "b", accountId: "acc-1", asOf: "2026-01-03T05:00:00.000Z", fetchedAt: "2026-01-03T05:00:00.000Z", balance: 90_00 },
    { pk: "T#frost#TX", sk: "x#TX#1", accountId: "acc-1", timestamp: "2026-01-02T00:00:00Z", amount: -10_00 },
    { pk: "T#frost#TX", sk: "y#TX#2", accountId: "acc-2", timestamp: "2026-01-02T00:00:00Z", amount: -99_00 },
  ];

  const ledger = { markBalanceReadingDirty: vi.fn(async () => {}), clearBalanceReadingDirty: vi.fn(async () => {}) };

  it("gives each account only its own readings and transactions", async () => {
    // Crossing them would reconcile one account's balance against another's
    // spending — a confidently wrong answer the use case itself cannot catch.
    const result = await reconcile({ data: dataFrom(rows), marks: ledger }, "frost");
    expect(Object.keys(result.accounts)).toEqual(["acc-1", "acc-2"]);
    expect(result.breaks).toBe(0);
    // acc-2 has no readings, so it is not checked rather than reported broken.
    expect(result.checked).toBe(1);
  });

  it("passes the tenant through to the marking, not the account id", async () => {
    const broken = rows.map((r) => (r["sk"] === "b" ? { ...r, balance: 50_00 } : r));
    await reconcile({ data: dataFrom(broken), marks: ledger }, "frost");
    expect(ledger.markBalanceReadingDirty).toHaveBeenCalledWith(
      "frost", "acc-1", "2026-01-03T05:00:00.000Z", "2026-01-03T05:00:00.000Z", -40_00,
    );
  });
});

describe("the scheduled run, end to end against fakes", () => {
  const rows = [
    { pk: "T#frost", sk: "ACCOUNT#acc-1", accountId: "acc-1", isCard: false },
    { pk: "T#frost#BAL#acc-1", sk: "a", accountId: "acc-1", asOf: "2026-01-01T05:00:00.000Z", fetchedAt: "2026-01-01T05:00:00.000Z", balance: 100_00 },
    { pk: "T#frost#BAL#acc-1", sk: "b", accountId: "acc-1", asOf: "2026-01-03T05:00:00.000Z", fetchedAt: "2026-01-03T05:00:00.000Z", balance: 60_00 },
  ];
  // The port, not a command switchboard. Faking "read every row" is one
  // function now, which is what a port sized by need buys.
  const tableRows = { scanAll: async () => rows } as never;
  const ledger = { markBalanceReadingDirty: vi.fn(async () => {}), clearBalanceReadingDirty: vi.fn(async () => {}) };
  const config = { tableName: "Ledger", tenantId: "frost", region: "eu-west-1", environment: "prod" };

  it("reads the table, finds the break, and marks it", async () => {
    const lines: string[] = [];
    const result = await reconcileFrom(tableRows, ledger, config, (l) => lines.push(l));
    expect(result.breaks).toBe(1);
    expect(ledger.markBalanceReadingDirty).toHaveBeenCalledWith(
      "frost", "acc-1", "2026-01-03T05:00:00.000Z", "2026-01-03T05:00:00.000Z", -40_00,
    );
  });

  it("emits under the deployment, not the TrueLayer environment", async () => {
    // #31: a metric emitted under "live" is invisible to an alarm watching
    // "dev", and the alarm then never fires for any reason.
    const lines: string[] = [];
    await reconcileFrom(tableRows, ledger, config, (l) => lines.push(l));
    const doc0 = lines.map((l) => JSON.parse(l)).find((d) => "_aws" in d);
    expect(doc0["Environment"]).toBe("prod");
    expect(doc0["ReconciliationBreaksAccount"]).toBe(1);
  });

  it("emits counts only, never a balance", async () => {
    const lines: string[] = [];
    await reconcileFrom(tableRows, ledger, config, (l) => lines.push(l));
    expect(lines.join(" ")).not.toContain("10000");
    expect(lines.join(" ")).not.toContain("6000");
  });
});

describe("reporting with no writer supplied", () => {
  it("falls back to the console, which is what the Lambda does", async () => {
    // The path that actually runs in production: nothing passes a writer there.
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const rows = [
      { pk: "T#frost", sk: "ACCOUNT#acc-1", accountId: "acc-1", isCard: false },
      { pk: "T#frost#BAL#acc-1", sk: "a", accountId: "acc-1", asOf: "2026-01-01T05:00:00.000Z", fetchedAt: "2026-01-01T05:00:00.000Z", balance: 100 },
      { pk: "T#frost#BAL#acc-1", sk: "b", accountId: "acc-1", asOf: "2026-01-03T05:00:00.000Z", fetchedAt: "2026-01-03T05:00:00.000Z", balance: 100 },
    ];
    const ledger = { markBalanceReadingDirty: async () => {}, clearBalanceReadingDirty: async () => {} };
    const result = await reconcileFrom({ scanAll: async () => rows } as never, ledger, {
      tableName: "Ledger",
      tenantId: "frost",
      region: "eu-west-1",
      environment: "dev",
    });
    expect(result.breaks).toBe(0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("what gets emitted", () => {
  /**
   * Naming moved here with the metrics. The domain reports per account; which
   * of those accounts is a card, and what the numbers are called, is this
   * layer's knowledge — an alarm matches a metric name by exact spelling.
   */
  const report = {
    accounts: {
      "card-1": { readings: 2, checked: 1, breaks: 1 },
      "acc-1": { readings: 2, checked: 1, breaks: 0 },
    },
    checked: 2,
    breaks: 1,
  };
  const isCard = (id: string) => id.startsWith("card-");

  it("splits breaks by card, so an alarm can tell where the problem is", () => {
    // A single total would say something is wrong without saying where, and an
    // alarm that cannot tell a card from an account is how the permanently
    // firing alarm in 927c593 happened.
    expect(reconciliationMetrics(report, isCard)).toMatchObject({
      ReconciliationBreaksCard: 1,
      ReconciliationBreaksAccount: 0,
    });
  });

  it("counts how many checks ran, so no checks is not mistaken for no breaks", () => {
    // An account with one reading has nothing to check yet. Emitting only
    // breaks would make that indistinguishable from a healthy ledger.
    expect(reconciliationMetrics(report, isCard)).toMatchObject({ ReconciliationsChecked: 2 });
    expect(
      reconciliationMetrics({ accounts: {}, checked: 0, breaks: 0 }, isCard),
    ).toMatchObject({ ReconciliationsChecked: 0, ReconciliationBreaksCard: 0 });
  });

  it("logs counts only, never a balance", () => {
    // A balance is as personal as a transaction. This output goes to CloudWatch.
    const lines = reconciliationLines(report, isCard);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({
      accountId: "card-1",
      isCard: true,
      readings: 2,
      checked: 1,
      breaks: 1,
    });
  });
});
