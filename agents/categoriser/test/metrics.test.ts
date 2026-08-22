import { describe, it, expect } from "vitest";
import { enrichmentMetrics } from "../src/metrics";
import type { CategoriseReport } from "@tightarse/domain";

/**
 * Naming moved here with the metrics: an alarm matches a CloudWatch metric by
 * exact spelling, so the names live where one can be seen being emitted. The
 * domain returns the facts.
 */

const report = (over: Partial<CategoriseReport> = {}): CategoriseReport => ({
  mode: "rules",
  skipped: false,
  backlog: 3,
  matchedByRules: 2,
  unmatched: 1,
  written: 2,
  customRules: 16,
  rejected: 0,
  missing: 0,
  inputTokens: 0,
  outputTokens: 0,
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
      EnrichmentInputTokens: 0,
      EnrichmentOutputTokens: 0,
    });
  });

  it("distinguishes matched from written", () => {
    // They differ when a transaction disappears between listing and writing,
    // and a run that matched plenty while writing nothing is worth seeing.
    const m = enrichmentMetrics(report({ written: 0 }));
    expect(m["EnrichmentWritten"]).toBe(0);
    expect(m["EnrichmentMatched"]).toBe(2);
  });

  it("emits token counts even when nothing was spent", () => {
    // Zero has to be a fact rather than an absence: a schedule that quietly
    // started calling the model would otherwise look exactly like one that
    // never did.
    expect(enrichmentMetrics(report())).toMatchObject({ EnrichmentInputTokens: 0 });
    expect(enrichmentMetrics(report({ inputTokens: 900, outputTokens: 120 }))).toMatchObject({
      EnrichmentInputTokens: 900,
      EnrichmentOutputTokens: 120,
    });
  });
});
