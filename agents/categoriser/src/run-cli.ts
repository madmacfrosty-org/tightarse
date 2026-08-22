/**
 * Apply the household's rules to the outstanding backlog.
 *
 * Wiring and presentation only — the work is the `categorise` use case in
 * @tightarse/domain, shared with the scheduled Lambda so the two cannot drift.
 * They did drift: this file used to hold its own copy of the write loop, so a
 * fix to one never reached the other.
 *
 *   TENANT=frost TABLE=<name> node dist/run-cli.js [--limit N] [--from D] [--to D] [--dry-run]
 *
 * Deterministic. Categorisation applies rules and nothing else — see
 * docs/design/categorisation.md for why a model proposes rules rather than
 * classifying transactions.
 */

import { DynamoStore } from "@tightarse/dynamodb";
import { enrich, type EnrichReport } from "@tightarse/domain";

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
  const dryRun = process.argv.includes("--dry-run");
  const limit = Number(arg("limit") ?? "0") || undefined;
  const from = arg("from") ?? "2021-01-01";
  const to = arg("to") ?? new Date().toISOString().slice(0, 10);
  const mode = arg("mode") as "off" | "rules" | undefined;

  const ledger = new DynamoStore({ tableName, region });

  const report = await enrich({ ledger }, tenantId, {
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

  print(report, dryRun);
}

function print(report: EnrichReport, dryRun: boolean): void {
  const { backlog, matched, unmatched } = report;
  console.log(`${backlog} transactions awaiting categorisation\n`);
  if (backlog === 0) return;
  if (report.customRules > 0) console.log(`${report.customRules} custom rules loaded`);
  console.log(
    `rules matched ${matched}/${backlog}` +
      ` (${((matched / backlog) * 100).toFixed(1)}%)` +
      `, ${unmatched} unmatched\n`,
  );

  console.log(`${dryRun ? "would write" : "wrote"} ${dryRun ? matched : report.written} enrichments`);

  if (dryRun && report.assignments.length > 0) {
    // Every assignment, not just the totals. A distribution can look entirely
    // plausible while individual rows are wrong, and the whole point of a
    // sample is to catch that before applying to the full ledger.
    // Ordered by category so the same assignment sits with its siblings, which
    // is how a wrong one shows up. This used to sort by confidence, "lowest
    // first, where errors hide" — over a value every rule set to 1.
    console.log(`\nassignments:\n`);
    const byKey = new Map(report.candidates.map((c) => [c.dedupKey, c]));
    const sorted = [...report.assignments].sort(
      (x, y) => x.category.localeCompare(y.category) || x.dedupKey.localeCompare(y.dedupKey),
    );
    for (const a of sorted) {
      const c = byKey.get(a.dedupKey);
      const amount = ((c?.amount ?? 0) / 100).toFixed(2).padStart(10);
      const raw = c?.description ?? "";
      const description = raw.length > 38 ? `${raw.slice(0, 37)}…` : raw;
      console.log(
        `  ${amount}  ${description.padEnd(38)}  ${a.category.padEnd(22)}${c?.providerCategory ?? ""}`,
      );
    }
  }

  console.log(`\ncategories assigned:`);
  for (const [category, n] of [...report.tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${category.padEnd(24)} ${String(n).padStart(5)}`);
  }
}

main().catch((err: unknown) => {
  console.error("\ncategoriser failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
