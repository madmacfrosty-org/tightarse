/**
 * What a categorisation run emits.
 *
 * Here rather than in the domain because these are CloudWatch metric names, and
 * an alarm matches them by exact spelling — the same reason `reconciliationMetrics`
 * sits with the transform. The domain returns the facts; naming them is this
 * layer's business.
 */

import type { CategoriseReport } from "@tightarse/domain";

export function enrichmentMetrics(report: CategoriseReport): Record<string, number> {
  return {
    EnrichmentBacklog: report.backlog,
    EnrichmentMatched: report.matchedByRules,
    EnrichmentWritten: report.written,
    EnrichmentUnmatched: report.unmatched,
    CustomRules: report.customRules,
    // Only the model path spends money. Emitted always so that zero is a fact
    // rather than an absence — a schedule that quietly started calling the model
    // would otherwise look exactly like one that never did.
    EnrichmentInputTokens: report.inputTokens,
    EnrichmentOutputTokens: report.outputTokens,
  };
}
