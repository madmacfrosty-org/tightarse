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
import { Ledger } from "@tightarse/ledger";
import { emit } from "@tightarse/metrics";
import { enrichmentMetrics, prepare, writeRuleEnrichments } from "./batch.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

export interface CategoriseEvent {
  /** Override the lookback for a one-off backfill after adding rules. */
  backfillDays?: number;
}

export async function handler(event: CategoriseEvent = {}): Promise<{
  backlog: number;
  matched: number;
  written: number;
  customRules: number;
}> {
  const tenantId = process.env["TENANT_ID"] ?? "frost";
  const ledger = new Ledger({
    tableName: required("TABLE_NAME"),
    region: process.env["AWS_REGION"] ?? "eu-west-1",
  });

  // Mode is a household setting and "off" means off — a schedule must respect
  // it, or turning enrichment off would silently do nothing.
  const settings = await ledger.getSettings(tenantId);
  const mode = settings?.enrichment ?? "rules";
  if (mode === "off") {
    console.log(JSON.stringify({ tenantId, mode, skipped: true }));
    return { backlog: 0, matched: 0, written: 0, customRules: 0 };
  }

  const days = event.backfillDays ?? Number(process.env["BACKFILL_DAYS"] ?? "45");
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const range = { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };

  const prepared = await prepare(ledger, tenantId, range);
  const { written, tally } = await writeRuleEnrichments(ledger, tenantId, prepared);

  // Counts and categories only. A description must never reach CloudWatch — it
  // is a merchant, a person's name, or an employer.
  emit({
    namespace: "Tightarse",
    environment: process.env["ENVIRONMENT"] ?? "dev",
    metrics: enrichmentMetrics(prepared, written),
    properties: { tenantId, mode },
  });

  console.log(
    JSON.stringify({
      tenantId,
      range,
      backlog: prepared.candidates.length,
      matched: prepared.classifications.length,
      written,
      customRules: prepared.customRuleCount,
      unmatched: prepared.unmatched.length,
      byCategory: Object.fromEntries(tally),
    }),
  );

  return {
    backlog: prepared.candidates.length,
    matched: prepared.classifications.length,
    written,
    customRules: prepared.customRuleCount,
  };
}
