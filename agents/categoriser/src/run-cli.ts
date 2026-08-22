/**
 * Categorise the outstanding backlog.
 *
 * Wiring and presentation only — the work is the `categorise` use case in
 * @tightarse/domain, shared with the scheduled Lambda so the two cannot drift.
 * They did drift: this file used to hold its own copy of the write loop, so a
 * fix to one never reached the other.
 *
 *   TENANT=frost TABLE=<name> node dist/run-cli.js [--limit N] [--from D] [--to D] [--dry-run]
 */

import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { DynamoStore } from "@tightarse/dynamodb";
import { categorise, type CategoriseReport } from "@tightarse/domain";
import { DEFAULT_MODEL } from "./bedrock.js";
import { bedrockClassifier } from "./classifier.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const tenantId = process.env["TENANT"] ?? "frost";
  const tableName = process.env["TABLE"];
  if (!tableName) {
    console.error("Missing TABLE");
    process.exit(1);
  }
  const region = process.env["AWS_REGION"] ?? "eu-west-1";
  const modelId = process.env["MODEL_ID"] ?? DEFAULT_MODEL;
  const dryRun = process.argv.includes("--dry-run");
  const limit = Number(arg("limit") ?? "0") || undefined;
  const from = arg("from") ?? "2021-01-01";
  const to = arg("to") ?? new Date().toISOString().slice(0, 10);
  const mode = arg("mode") as "off" | "rules" | "model" | undefined;

  const ledger = new DynamoStore({ tableName, region });
  const classifier = bedrockClassifier(new BedrockRuntimeClient({ region }), modelId);

  const report = await categorise({ ledger, classifier }, tenantId, {
    range: { from, to },
    now: new Date(),
    ...(limit === undefined ? {} : { limit }),
    ...(mode === undefined ? {} : { mode }),
    ...(dryRun ? { dryRun: true } : {}),
  });

  if (report.skipped) {
    console.log(`enrichment is "off" for ${tenantId} — provider payment type only. Nothing to do.`);
    return;
  }

  print(report, { modelId, dryRun });
}

function print(report: CategoriseReport, opts: { modelId: string; dryRun: boolean }): void {
  const { backlog, matchedByRules, unmatched } = report;
  console.log(
    `${backlog} transactions awaiting categorisation  (mode ${report.mode}` +
      `${report.mode === "model" ? `, ${opts.modelId}` : ""})\n`,
  );
  if (backlog === 0) return;
  if (report.customRules > 0) console.log(`${report.customRules} custom rules loaded`);
  console.log(
    `rules matched ${matchedByRules}/${backlog}` +
      ` (${((matchedByRules / backlog) * 100).toFixed(1)}%)` +
      `, ${unmatched} left for the model\n`,
  );

  console.log(`\n${opts.dryRun ? "would write" : "wrote"} ${opts.dryRun ? report.assignments.length : report.written} enrichments`);
  if (report.rejected > 0) console.log(`  ${report.rejected} responses outside the taxonomy, stored as Other`);
  if (report.missing > 0) console.log(`  ${report.missing} left in the backlog (no response)`);
  console.log(`  tokens: ${report.inputTokens} in, ${report.outputTokens} out`);

  if (opts.dryRun && report.assignments.length > 0) {
    // Every assignment, not just the totals. A distribution can look entirely
    // plausible while individual rows are wrong, and the whole point of a
    // sample is to catch that before spending on 9,653.
    console.log(`\nassignments (lowest confidence first — where errors hide):\n`);
    const byKey = new Map(report.candidates.map((c) => [c.dedupKey, c]));
    const sorted = [...report.assignments].sort((a, b) => a.confidence - b.confidence);
    for (const a of sorted) {
      const c = byKey.get(a.dedupKey);
      const amt = ((c?.amount ?? 0) / 100).toFixed(2).padStart(10);
      const raw = c?.description ?? "";
      const desc = raw.length > 38 ? `${raw.slice(0, 37)}…` : raw;
      console.log(
        `  ${a.confidence.toFixed(2)}  ${amt}  ${desc.padEnd(38)}  ${a.category.padEnd(22)}${c?.providerCategory ?? ""}`,
      );
    }
  }

  console.log(`\ncategories assigned:`);
  for (const [c, n] of [...report.tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.padEnd(24)} ${String(n).padStart(5)}`);
  }
}

main().catch((err: unknown) => {
  console.error("\ncategoriser failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
