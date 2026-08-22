/**
 * What a categorisation run emits.
 *
 * Here rather than in the domain because these are CloudWatch metric names, and
 * an alarm matches them by exact spelling — the same reason `reconciliationMetrics`
 * sits with the transform. The domain returns the facts; naming them is this
 * layer's business.
 */

import type { EnrichReport } from "@tightarse/domain";

export function enrichmentMetrics(report: EnrichReport): Record<string, number> {
  return {
    EnrichmentBacklog: report.backlog,
    EnrichmentMatched: report.matched,
    EnrichmentWritten: report.written,
    EnrichmentUnmatched: report.unmatched,
    CustomRules: report.customRules,
  };
}
