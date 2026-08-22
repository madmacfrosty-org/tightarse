import { describe, it, expect } from "vitest";
import { enrichmentMetrics } from "../src/metrics";
import type { EnrichReport } from "@tightarse/domain";

/**
 * Naming moved here with the metrics: an alarm matches a CloudWatch metric by
 * exact spelling, so the names live where one can be seen being emitted. The
 * domain returns the facts.
 */

const report = (over: Partial<EnrichReport> = {}): EnrichReport => ({
  mode: "rules",
  skipped: false,
  backlog: 3,
  matched: 2,
  unmatched: 1,
  written: 2,
  customRules: 16,
  tally: new Map(),
  assignments: [],
  candidates: [],
  ...over,
});

describe("enrichmentMetrics", () => {
  it("reports the backlog, what matched, and what was left", () => {
    expect(enrichmentMetrics(report())).toEqual({
      EnrichmentBacklog: 3,
      EnrichmentMatched: 2,
      EnrichmentWritten: 2,
      EnrichmentUnmatched: 1,
      CustomRules: 16,
    });
  });

  it("distinguishes matched from written", () => {
    // They differ when a transaction disappears between listing and writing,
    // and a run that matched plenty while writing nothing is worth seeing.
    const m = enrichmentMetrics(report({ written: 0 }));
    expect(m["EnrichmentWritten"]).toBe(0);
    expect(m["EnrichmentMatched"]).toBe(2);
  });
});
