/**
 * What a categorisation run emits.
 *
 * Here rather than in the domain because these are CloudWatch metric names, and
 * an alarm matches them by exact spelling — the same reason `reconciliationMetrics`
 * sits with the transform. The domain returns the facts; naming them is this
 * layer's business.
 */

import type { CategoriseReport } from "@tightarse/domain";

export function categorisationMetrics(report: CategoriseReport): Record<string, number> {
  return {
    CategorisationScanned: report.scanned,
    CategorisationAppended: report.appended,
    CategorisationUnchanged: report.unchanged,
    CategorisationUncategorised: report.uncategorised,
    // Left alone because an authored set produced them. Not a problem; a number
    // that should be explicable rather than surprising when someone asks why a
    // rule change did not reach a transaction.
    CategorisationProtected: report.protectedFromChange,
    // A stored category nothing matches any more. Needs attention rather than
    // silence: keeping a category nobody can explain is worse than saying so.
    CategorisationOrphaned: report.orphaned,
    // Rule defects. A conflicted set produces nothing at all, so these cost
    // coverage as well as being wrong.
    CategorisationConflicts: report.conflicts,
    CategorisationInertRefines: report.inertRefines,
  };
}
