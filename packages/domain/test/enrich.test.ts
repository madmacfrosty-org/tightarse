import { describe, it, expect } from "vitest";
import { enrich } from "../src/application/enrich.js";
import type { TransactionEnrichment } from "../src/categorisation/enrichment.js";

/**
 * Enriching a household's backlog with its merchant rules.
 *
 * Deterministic throughout: rules are data, applying them is mechanical, and the
 * same rules over the same transactions give the same answer every time. What
 * matters here is not which rule matches — that is merchant-rules' business —
 * but that "off" means off, that what matched gets written, and that a dry run
 * writes nothing while still reporting what it saw.
 */

const NOW = new Date("2026-03-01T09:00:00.000Z");
const RANGE = { from: "2026-01-01", to: "2026-03-01" };

const row = (dedupKey: string, description: string) => ({
  dedupKey,
  description,
  amount: -10_00,
  timestamp: "2026-02-01T00:00:00.000Z",
});

function ledgerWith(
  rows: ReadonlyArray<Record<string, unknown>>,
  enrichment: "off" | "rules" | "model" = "rules",
) {
  const written: TransactionEnrichment[] = [];
  return {
    written,
    ledger: {
      listToEnrich: async (_t: string, _r: unknown, limit?: number) =>
        limit === undefined ? [...rows] : rows.slice(0, limit),
      getCustomRules: async () => [],
      putEnrichment: async (e: TransactionEnrichment) => {
        written.push(e);
      },
      getSettings: async () => ({ tenantId: "frost", enrichment }) as never,
    },
  };
}

describe("what the household has chosen", () => {
  it("does nothing at all when enrichment is off", async () => {
    // Turning it off has to stop the schedule, or the setting is decorative.
    const { ledger, written } = ledgerWith([row("a", "TESCO STORES 3411")], "off");
    const report = await enrich({ ledger }, "frost", { range: RANGE, now: NOW });
    expect(report.skipped).toBe(true);
    expect(report.mode).toBe("off");
    expect(written).toHaveLength(0);
    expect(report.assignments).toEqual([]);
    expect(report.candidates).toEqual([]);
  });

  it("defaults to rules for a household with no settings row", async () => {
    // A new household has no settings until someone saves some. Rules are the
    // only thing categorisation does, so they are also the only sensible
    // default; "off" would leave the ledger uncategorised with nothing to say
    // why.
    const { ledger, written } = ledgerWith([row("a", "TESCO STORES 3411")]);
    const report = await enrich(
      { ledger: { ...ledger, getSettings: async () => null } },
      "frost",
      { range: RANGE, now: NOW },
    );
    expect(report.mode).toBe("rules");
    expect(report.skipped).toBe(false);
    expect(written).toHaveLength(1);
  });

  it("applies rules for a household still set to model, rather than refusing", async () => {
    // "model" is a legacy setting. Categorisation is rules and nothing else, so
    // the honest behaviour is to apply them rather than to fail or skip.
    const { ledger, written } = ledgerWith([row("a", "TESCO STORES 3411")], "model");
    const report = await enrich({ ledger }, "frost", { range: RANGE, now: NOW });
    expect(report.skipped).toBe(false);
    expect(written).toHaveLength(1);
  });
});

describe("applying the rules", () => {
  it("writes what matched and leaves the rest in the backlog", async () => {
    const { ledger, written } = ledgerWith([row("a", "TESCO STORES 3411"), row("b", "ZZQX UNKNOWN 99")]);
    const report = await enrich({ ledger }, "frost", { range: RANGE, now: NOW });
    expect(report.matched).toBe(1);
    expect(report.unmatched).toBe(1);
    expect(report.written).toBe(1);
    expect(written).toHaveLength(1);
  });

  it("attributes every enrichment to the rules version that produced it", async () => {
    // Every categorisation is rule-derived, so every one can be reproduced and
    // re-applied. That is the property the whole design turns on.
    const { ledger, written } = ledgerWith([row("a", "TESCO STORES 3411")]);
    await enrich({ ledger }, "frost", { range: RANGE, now: NOW });
    expect(written[0]?.producedBy).toMatch(/^rules@/);
    expect(written[0]?.producedAt).toBe(NOW.toISOString());
  });

  it("tallies what landed in each category", async () => {
    const { ledger } = ledgerWith([row("a", "TESCO STORES 3411"), row("b", "TESCO STORES 3411")]);
    const report = await enrich({ ledger }, "frost", { range: RANGE, now: NOW });
    expect([...report.tally.values()].reduce((x, y) => x + y, 0)).toBe(2);
  });

  it("passes a limit through to the backlog read", async () => {
    const { ledger } = ledgerWith([row("a", "TESCO STORES 3411"), row("b", "TESCO STORES 3411")]);
    const report = await enrich({ ledger }, "frost", { range: RANGE, now: NOW, limit: 1 });
    expect(report.backlog).toBe(1);
  });
});

describe("a dry run", () => {
  it("counts what it would assign and writes nothing", async () => {
    const { ledger, written } = ledgerWith([row("a", "TESCO STORES 3411"), row("b", "ZZQX UNKNOWN 99")]);
    const report = await enrich({ ledger }, "frost", { range: RANGE, now: NOW, dryRun: true });
    expect(written).toHaveLength(0);
    expect(report.written).toBe(0);
    // Still reports what it saw, which is the entire point of a dry run.
    expect(report.assignments).toHaveLength(1);
    expect([...report.tally.values()].reduce((x, y) => x + y, 0)).toBe(1);
  });
});
