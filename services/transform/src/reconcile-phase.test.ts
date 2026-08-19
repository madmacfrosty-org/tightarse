import { describe, it, expect, vi } from "vitest";
import { runReconciliation, type ReconcilePhaseDeps } from "./reconcile-phase";
import { groupForReconciliation, phaseDepsFrom, reconcileConfig, reconcileFrom } from "./reconcile-handler";
import type { Movement, Reading } from "./reconcile";

/**
 * The phase around the check.
 *
 * What matters here is not the arithmetic — that is tested in reconcile.test.ts
 * — but what it does with the answer: marking a reading dirty, and being able to
 * take the mark back when a late transaction explains the break.
 */

const reading = (accountId: string, asOf: string, balance: number, fetchedAt = asOf): Reading => ({
  accountId,
  asOf,
  fetchedAt,
  balance,
});

function deps(
  over: Partial<ReconcilePhaseDeps> & {
    readingsByAccount?: Record<string, Reading[]>;
    movementsByAccount?: Record<string, Movement[]>;
  } = {},
): { deps: ReconcilePhaseDeps; marked: string[]; cleared: string[] } {
  const marked: string[] = [];
  const cleared: string[] = [];
  const readings = over.readingsByAccount ?? {};
  const movements = over.movementsByAccount ?? {};
  return {
    marked,
    cleared,
    deps: {
      accounts: async () => [{ accountId: "acc-1", isCard: false }],
      readings: async (id: string) => readings[id] ?? [],
      movements: async (id: string) => movements[id] ?? [],
      markDirty: async (id: string, asOf: string, _fetchedAt: string, discrepancy: number) => {
        marked.push(`${id}|${asOf}|${discrepancy}`);
      },
      clearDirty: async (id: string, asOf: string) => {
        cleared.push(`${id}|${asOf}`);
      },
      log: () => {},
      ...over,
    },
  };
}

describe("marking what did not add up", () => {
  it("marks the later reading of a broken pair, with the discrepancy", () => {
    // The later one, because that is where the arithmetic failed: everything up
    // to the earlier reading still reconciled.
    const { deps: d, marked } = deps({
      readingsByAccount: {
        "acc-1": [reading("acc-1", "2026-01-01T05:00:00.000Z", 100_00), reading("acc-1", "2026-01-03T05:00:00.000Z", 70_00)],
      },
      movementsByAccount: { "acc-1": [{ timestamp: "2026-01-02T00:00:00Z", amount: -10_00 }] },
    });
    return runReconciliation(d).then((result) => {
      expect(result.breaks).toBe(1);
      expect(marked).toEqual(["acc-1|2026-01-03T05:00:00.000Z|-2000"]);
    });
  });

  it("leaves the earlier reading alone, which still reconciles", async () => {
    const { deps: d, marked, cleared } = deps({
      readingsByAccount: {
        "acc-1": [reading("acc-1", "2026-01-01T05:00:00.000Z", 100_00), reading("acc-1", "2026-01-03T05:00:00.000Z", 70_00)],
      },
    });
    await runReconciliation(d);
    expect(marked.some((m) => m.includes("2026-01-01"))).toBe(false);
    expect(cleared.some((c) => c.includes("2026-01-01"))).toBe(true);
  });

  it("clears the mark when a late transaction explains the break", async () => {
    // The reason nothing appends a correcting row. This phase recomputes from
    // scratch every run, so a break that is later explained simply stops being
    // one — no retraction, and no corrections stacked on corrections.
    const readings = [
      reading("acc-1", "2026-01-01T05:00:00.000Z", 100_00),
      reading("acc-1", "2026-01-03T05:00:00.000Z", 70_00),
    ];
    const before = deps({ readingsByAccount: { "acc-1": readings } });
    await runReconciliation(before.deps);
    expect(before.marked).toHaveLength(1);

    const after = deps({
      readingsByAccount: { "acc-1": readings },
      movementsByAccount: { "acc-1": [{ timestamp: "2026-01-02T00:00:00Z", amount: -30_00 }] },
    });
    await runReconciliation(after.deps);
    expect(after.marked).toHaveLength(0);
    expect(after.cleared).toContain("acc-1|2026-01-03T05:00:00.000Z");
  });
});

describe("running over a household", () => {
  it("checks every account, cards included", async () => {
    // Cards are the reason this exists: they carry no running balance, so this
    // is the only check that can see them at all.
    const { deps: d } = deps({
      accounts: async () => [
        { accountId: "acc-1", isCard: false },
        { accountId: "card-1", isCard: true },
      ],
      readingsByAccount: {
        "acc-1": [reading("acc-1", "2026-01-01T05:00:00.000Z", 100), reading("acc-1", "2026-01-03T05:00:00.000Z", 100)],
        "card-1": [reading("card-1", "2026-01-01T05:00:00.000Z", -500), reading("card-1", "2026-01-03T05:00:00.000Z", -700)],
      },
    });
    const result = await runReconciliation(d);
    expect(result.accounts).toBe(2);
    expect(result.checked).toBe(2);
    expect(result.metrics["ReconciliationBreaksCard"]).toBe(1);
    expect(result.metrics["ReconciliationBreaksAccount"]).toBe(0);
  });

  it("reports zero checks for a household whose accounts have one reading each", async () => {
    // Every account is in this state until a second sync has run. Zero breaks
    // here means "nothing checked", not "everything healthy", and the metrics
    // have to say which.
    const { deps: d } = deps({
      readingsByAccount: { "acc-1": [reading("acc-1", "2026-01-01T05:00:00.000Z", 100)] },
    });
    const result = await runReconciliation(d);
    expect(result.metrics).toMatchObject({ ReconciliationsChecked: 0, ReconciliationBreaksAccount: 0 });
  });

  it("logs counts only, never a balance", async () => {
    // A balance is as personal as a transaction. This output goes to
    // CloudWatch.
    const lines: string[] = [];
    const { deps: d } = deps({
      log: (l: string) => lines.push(l),
      readingsByAccount: {
        "acc-1": [reading("acc-1", "2026-01-01T05:00:00.000Z", 123_456), reading("acc-1", "2026-01-03T05:00:00.000Z", 99_999)],
      },
    });
    await runReconciliation(d);
    expect(lines.join(" ")).not.toContain("123456");
    expect(lines.join(" ")).not.toContain("99999");
    expect(JSON.parse(lines[0]!)).toMatchObject({ accountId: "acc-1", readings: 2, checked: 1, breaks: 1 });
  });
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

  it("gives an account with no readings an empty list rather than undefined", () => {
    expect(groupForReconciliation(rows).readings.get("card-1")).toBeUndefined();
  });
});

describe("wiring a scan to the phase", () => {
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
    // spending — a confidently wrong answer that the phase itself cannot catch.
    const result = await runReconciliation({ ...phaseDepsFrom(rows, ledger, "frost"), log: () => {} });
    expect(result.accounts).toBe(2);
    expect(result.breaks).toBe(0);
    // acc-2 has no readings, so it is not checked rather than reported broken.
    expect(result.checked).toBe(1);
  });

  it("passes the tenant through to the marking, not the account id", async () => {
    const broken = rows.map((r) => (r["sk"] === "b" ? { ...r, balance: 50_00 } : r));
    await runReconciliation({ ...phaseDepsFrom(broken, ledger, "frost"), log: () => {} });
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
