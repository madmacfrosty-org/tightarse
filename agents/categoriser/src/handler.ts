/**
 * Scheduled categorisation.
 *
 * Until this existed, categorisation was a command somebody typed. That made
 * coverage a high-water mark rather than a floor: the daily sync lands new
 * transactions every morning and nothing categorised them, so the proportion of
 * the ledger with a category fell a little every day.
 *
 * Applies the household's rule sets and appends a version where the answer
 * differs. Deterministic, and idempotent — an unchanged answer writes nothing,
 * so running daily over the whole range costs almost nothing.
 *
 * The window is the whole ledger by default, not a lookback. Scope cannot be
 * narrowed by a changed rule's footprint: a new `refine` changes the outcome for
 * transactions where a DIFFERENT rule did the asserting, so anything narrower is
 * a guess about which rows a rule change can reach.
 */
import { DynamoStore } from "@tightarse/dynamodb";
import { emit } from "@tightarse/metrics";
import { categorise as applyRuleSets, type CategoriseReport } from "@tightarse/domain";
import { categorisationMetrics } from "./metrics.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

export interface CategoriseEvent {
  /** Narrow the window. Present for a one-off; the schedule passes nothing. */
  from?: string;
  to?: string;
}

/**
 * Everything this run reaches outside itself.
 *
 * The clients used to be constructed inside the handler, which meant nothing
 * could test what it does without a table and a region.
 */
export interface CategoriseDeps {
  readonly ledger: DynamoStore;
  readonly tenantId: string;
  readonly environment: string;
}

/** Built by the entry point below, and by nothing a test runs. */
export function realDeps(): CategoriseDeps {
  return {
    ledger: new DynamoStore({
      tableName: required("TABLE_NAME"),
      region: process.env["AWS_REGION"] ?? "eu-west-1",
    }),
    tenantId: process.env["TENANT_ID"] ?? "frost",
    environment: process.env["ENVIRONMENT"] ?? "dev",
  };
}

/** Nothing happened, because the household asked for nothing to happen. */
const NOTHING: CategoriseReport = {
  scanned: 0,
  unchanged: 0,
  appended: 0,
  protectedFromChange: 0,
  orphaned: 0,
  uncategorised: 0,
  conflicts: 0,
  inertRefines: 0,
  changes: [],
};

export async function categorise(
  deps: CategoriseDeps,
  event: CategoriseEvent = {},
): Promise<CategoriseReport> {
  const { ledger, tenantId } = deps;

  // The household's off switch, honoured here rather than in the use case: it
  // is a control-plane setting about whether to run, not a rule about how to
  // categorise. It predates the rule-set model and applying rules without
  // checking it would silently take away a control somebody set.
  const settings = await ledger.getSettings(tenantId);
  if (settings?.enrichment === "off") {
    console.log(JSON.stringify({ tenantId, skipped: true, reason: "enrichment is off" }));
    return NOTHING;
  }

  const to = event.to ?? new Date().toISOString().slice(0, 10);
  const from = event.from ?? "2000-01-01";

  const report = await applyRuleSets(
    { transactions: ledger, ruleSets: ledger, categorisations: ledger },
    tenantId,
    { range: { from, to }, now: new Date() },
  );

  // Counts and categories only. A description must never reach CloudWatch — it
  // is a merchant, a person's name, or an employer.
  emit({
    namespace: "Tightarse",
    environment: deps.environment,
    metrics: categorisationMetrics(report),
    properties: { tenantId },
  });

  console.log(
    JSON.stringify({
      tenantId,
      range: { from, to },
      scanned: report.scanned,
      appended: report.appended,
      unchanged: report.unchanged,
      uncategorised: report.uncategorised,
      protectedFromChange: report.protectedFromChange,
      orphaned: report.orphaned,
      conflicts: report.conflicts,
      inertRefines: report.inertRefines,
    }),
  );

  return report;
}

/**
 * Lambda entry point, and the only place a client is constructed.
 *
 * Built per invocation rather than at module scope: caching across warm
 * invocations would be cheap and probably right, but it changes when TABLE_NAME
 * is read, and that is not a trade to make silently inside a refactor.
 */
export async function handler(event: CategoriseEvent = {}) {
  return categorise(realDeps(), event);
}
