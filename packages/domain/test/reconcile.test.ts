import { describe, it, expect } from "vitest";
import { reconcile, reconciliation } from "../src/application/reconcile.js";
import type { ReconcileDeps } from "../src/application/reconcile.js";
import type { ReconciliationMovement, Reading } from "../src/ledger/reconciliation.js";

/**
 * The use case around the check.
 *
 * What matters here is not the arithmetic — that is tested in
 * reconciliation.test.ts — but what it does with the answer: marking a reading
 * dirty, and being able to take the mark back when a late transaction explains
 * the break.
 */

const TENANT = "frost";

const reading = (accountId: string, asOf: string, balance: number, fetchedAt = asOf): Reading => ({
  accountId,
  asOf,
  fetchedAt,
  balance,
});

function deps(
  over: {
    accounts?: () => Promise<readonly { accountId: string; isCard: boolean }[]>;
    readingsByAccount?: Record<string, Reading[]>;
    movementsByAccount?: Record<string, ReconciliationMovement[]>;
  } = {},
): { deps: ReconcileDeps; marked: string[]; cleared: string[] } {
  const marked: string[] = [];
  const cleared: string[] = [];
  const readings = over.readingsByAccount ?? {};
  const movements = over.movementsByAccount ?? {};
  return {
    marked,
    cleared,
    deps: {
      data: {
        accounts: over.accounts ?? (async () => [{ accountId: "acc-1", isCard: false }]),
        readings: async (id: string) => readings[id] ?? [],
        movements: async (id: string) => movements[id] ?? [],
      },
      marks: {
        markBalanceReadingDirty: async (
          tenantId: string,
          id: string,
          asOf: string,
          _fetchedAt: string,
          discrepancy: number,
        ) => {
          marked.push(`${tenantId}|${id}|${asOf}|${discrepancy}`);
        },
        clearBalanceReadingDirty: async (tenantId: string, id: string, asOf: string) => {
          cleared.push(`${tenantId}|${id}|${asOf}`);
        },
      },
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
    return reconcile(d, TENANT).then((result) => {
      expect(result.breaks).toBe(1);
      expect(marked).toEqual(["frost|acc-1|2026-01-03T05:00:00.000Z|-2000"]);
    });
  });

  it("leaves the earlier reading alone, which still reconciles", async () => {
    const { deps: d, marked, cleared } = deps({
      readingsByAccount: {
        "acc-1": [reading("acc-1", "2026-01-01T05:00:00.000Z", 100_00), reading("acc-1", "2026-01-03T05:00:00.000Z", 70_00)],
      },
    });
    await reconcile(d, TENANT);
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
    await reconcile(before.deps, TENANT);
    expect(before.marked).toHaveLength(1);

    const after = deps({
      readingsByAccount: { "acc-1": readings },
      movementsByAccount: { "acc-1": [{ timestamp: "2026-01-02T00:00:00Z", amount: -30_00 }] },
    });
    await reconcile(after.deps, TENANT);
    expect(after.marked).toHaveLength(0);
    expect(after.cleared).toContain("frost|acc-1|2026-01-03T05:00:00.000Z");
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
    const result = await reconcile(d, TENANT);
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
    const result = await reconcile(d, TENANT);
    expect(result.metrics).toMatchObject({ ReconciliationsChecked: 0, ReconciliationBreaksAccount: 0 });
  });

  it("logs counts only, never a balance", async () => {
    // A balance is as personal as a transaction. This output goes to
    // CloudWatch.
    const { deps: d } = deps({
      readingsByAccount: {
        "acc-1": [reading("acc-1", "2026-01-01T05:00:00.000Z", 123_456), reading("acc-1", "2026-01-03T05:00:00.000Z", 99_999)],
      },
    });
    const { lines } = await reconcile(d, TENANT);
    expect(lines.join(" ")).not.toContain("123456");
    expect(lines.join(" ")).not.toContain("99999");
    expect(JSON.parse(lines[0]!)).toMatchObject({ accountId: "acc-1", readings: 2, checked: 1, breaks: 1 });
  });
});

describe("behind the inbound port", () => {
  /**
   * `reconciliation()` is what a driver holds — the scheduled Lambda and the
   * CLI both reach the use case through it, and neither passes a tenant any
   * other way.
   */
  it("runs for the household it is given", async () => {
    const { deps: d, marked } = deps({
      readingsByAccount: {
        "acc-1": [
          reading("acc-1", "2026-01-01T05:00:00.000Z", 100_00),
          reading("acc-1", "2026-01-03T05:00:00.000Z", 70_00),
        ],
      },
    });
    const report = await reconciliation(d).run("someone-else");
    expect(report.breaks).toBe(1);
    // The tenant reaches the mark, rather than a default reaching it.
    expect(marked[0]).toContain("someone-else|acc-1");
  });
});
