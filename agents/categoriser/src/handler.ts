/**
 * Scheduled categorisation, rules only.
 *
 * Until this existed, categorisation was a command somebody typed. That made
 * coverage a high-water mark rather than a floor: the daily sync lands new
 * transactions every morning and nothing categorised them, so the proportion
 * of the ledger with a category fell a little every day.
 *
 * Rules only, deliberately. The model path costs money per run and belongs to
 * an operator deciding to spend it, not to a schedule that spends it at 06:00
 * whether or not anyone looks. `run.ts` still has it.
 *
 * The window is short by default. New transactions are what this is for, and
 * the backlog is derived by diffing transactions against enrichments, so a
 * narrow range keeps the daily read small. Widen it with BACKFILL_DAYS when a
 * new rule should be applied to history.
 */
import { DynamoStore } from "@tightarse/dynamodb";
import { emit } from "@tightarse/metrics";
import { categorise as runCategorisation } from "@tightarse/domain";
import type { CategoriserReads } from "@tightarse/domain";
import { enrichmentMetrics } from "./metrics.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

export interface CategoriseEvent {
  /** Override the lookback for a one-off backfill after adding rules. */
  backfillDays?: number;
}

/**
 * Everything this run reaches outside itself.
 *
 * The client used to be constructed inside the handler, which meant nothing
 * could test the one decision that matters here — that `enrichment: "off"` is
 * honoured — without a table and a region. `backfillDays` and `tenantId` come
 * in the same way, so a test does not have to mutate `process.env`.
 */
export interface CategoriseDeps {
  readonly ledger: CategoriserReads;
  readonly tenantId: string;
  /** Lookback when the event does not override it. */
  readonly defaultBackfillDays: number;
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
    defaultBackfillDays: Number(process.env["BACKFILL_DAYS"] ?? "45"),
    environment: process.env["ENVIRONMENT"] ?? "dev",
  };
}

export async function categorise(
  deps: CategoriseDeps,
  event: CategoriseEvent = {},
): Promise<{
  backlog: number;
  matched: number;
  written: number;
  customRules: number;
}> {
  const { ledger, tenantId } = deps;

  const days = event.backfillDays ?? deps.defaultBackfillDays;
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const range = { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };

  // No classifier. The model costs money per run and that belongs to an operator
  // deciding to spend it, not to a schedule that spends it at 06:00 whether or
  // not anyone looks. The use case is rules-only without one, even for a
  // household whose setting says "model".
  const report = await runCategorisation({ ledger }, tenantId, { range, now: to });

  if (report.skipped) {
    console.log(JSON.stringify({ tenantId, mode: report.mode, skipped: true }));
    return { backlog: 0, matched: 0, written: 0, customRules: 0 };
  }

  // Counts and categories only. A description must never reach CloudWatch — it
  // is a merchant, a person's name, or an employer.
  emit({
    namespace: "Tightarse",
    environment: deps.environment,
    metrics: enrichmentMetrics(report),
    properties: { tenantId, mode: report.mode },
  });

  console.log(
    JSON.stringify({
      tenantId,
      range,
      backlog: report.backlog,
      matched: report.matchedByRules,
      written: report.written,
      customRules: report.customRules,
      unmatched: report.unmatched,
      byCategory: Object.fromEntries(report.tally),
    }),
  );

  return {
    backlog: report.backlog,
    matched: report.matchedByRules,
    written: report.written,
    customRules: report.customRules,
  };
}

/**
 * Lambda entry point, and the only place a client is constructed.
 *
 * Built per invocation, as the previous code did — this handler constructed its
 * the store inside itself rather than at module scope. Caching across warm
 * invocations would be cheap and probably right, but it also changes when
 * TABLE_NAME and BACKFILL_DAYS are read, and that is not a trade to make
 * silently inside a refactor.
 */
export async function handler(event: CategoriseEvent = {}) {
  return categorise(realDeps(), event);
}
