import { describe, it, expect } from "vitest";
import { categorisationMetrics } from "../src/metrics";
import type { CategoriseReport } from "@tightarse/domain";

/**
 * Naming lives here: an alarm matches a CloudWatch metric by exact spelling, so
 * the names sit where one can be seen being emitted. The domain returns facts.
 */

const report = (over: Partial<CategoriseReport> = {}): CategoriseReport => ({
  scanned: 100,
  unchanged: 60,
  appended: 30,
  orphaned: 1,
  uncategorised: 7,
  conflicts: 4,
  inertRefines: 0,
  changes: [],
  ...over,
});

describe("categorisationMetrics", () => {
  it("reports what the run did, in full", () => {
    expect(categorisationMetrics(report())).toEqual({
      CategorisationScanned: 100,
      CategorisationAppended: 30,
      CategorisationUnchanged: 60,
      CategorisationUncategorised: 7,
      CategorisationOrphaned: 1,
      CategorisationConflicts: 4,
      CategorisationInertRefines: 0,
    });
  });

  it("emits zeros rather than omitting them", () => {
    // A metric that disappears when it is zero cannot be alarmed on: "no data"
    // and "nothing wrong" become the same signal.
    const m = categorisationMetrics(report({ conflicts: 0, orphaned: 0, appended: 0 }));
    expect(m["CategorisationConflicts"]).toBe(0);
    expect(m["CategorisationOrphaned"]).toBe(0);
    expect(m["CategorisationAppended"]).toBe(0);
  });

  it("distinguishes appended from unchanged", () => {
    // They differ on every run after the first, and a run that appended nothing
    // because nothing changed is the healthy case rather than a failure.
    const m = categorisationMetrics(report({ appended: 0, unchanged: 100 }));
    expect(m["CategorisationAppended"]).toBe(0);
    expect(m["CategorisationUnchanged"]).toBe(100);
  });
});
