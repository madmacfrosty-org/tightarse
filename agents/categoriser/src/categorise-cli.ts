/**
 * Apply the household's rule sets to its ledger.
 *
 *   TENANT=frost TABLE=<name> npm run categorise -w @tightarse/categoriser
 *   ... -- --write                 actually write
 *   ... -- --from 2021-01-01 --to 2026-12-31
 *
 * Dry by default. Re-application can change history — that is the point of it,
 * and it is also what erodes trust when a figure someone looked at last month
 * quietly says something different now. The first real run should be read by a
 * person before anything is written.
 */

import { DynamoStore } from "@tightarse/dynamodb";
import { categorise, type CategoriseReport } from "@tightarse/domain";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const tenantId = process.env["TENANT"] ?? "frost";
  const tableName = process.env["TABLE"];
  if (!tableName) {
    console.error("Missing TABLE");
    process.exit(1);
  }
  const region = process.env["AWS_REGION"] ?? "eu-west-1";
  const write = process.argv.includes("--write");
  const from = arg("from") ?? "2021-01-01";
  const to = arg("to") ?? new Date().toISOString().slice(0, 10);

  const ledger = new DynamoStore({ tableName, region });
  const report = await categorise(
    { transactions: ledger, ruleSets: ledger, categorisations: ledger },
    tenantId,
    { range: { from, to }, now: new Date(), ...(write ? {} : { dryRun: true }) },
  );

  print(report, { write, from, to });
}

function print(report: CategoriseReport, opts: { write: boolean; from: string; to: string }): void {
  console.log(`${opts.write ? "applying" : "dry run"}  ${opts.from} to ${opts.to}\n`);
  console.log(`  scanned          ${String(report.scanned).padStart(6)}`);
  console.log(`  ${opts.write ? "written        " : "would change   "}  ${String(report.appended).padStart(6)}`);
  console.log(`  already correct  ${String(report.unchanged).padStart(6)}`);
  console.log(`  no rule matched  ${String(report.uncategorised).padStart(6)}`);
  console.log(`  orphaned         ${String(report.orphaned).padStart(6)}`);
  console.log(`  conflicts        ${String(report.conflicts).padStart(6)}`);
  console.log(`  inert refines    ${String(report.inertRefines).padStart(6)}`);

  if (report.changes.length === 0) return;

  const byTarget = new Map<string, number>();
  for (const c of report.changes) byTarget.set(c.to, (byTarget.get(c.to) ?? 0) + 1);
  console.log(`\nwould assign:`);
  for (const [category, n] of [...byTarget.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${category.padEnd(24)} ${String(n).padStart(5)}`);
  }

  // A sample rather than everything: the point is to judge whether the
  // assignments look right, and nobody reads nine thousand lines.
  const sample = Number(arg("sample") ?? "25");
  console.log(`\nsample of ${Math.min(sample, report.changes.length)}:\n`);
  for (const c of report.changes.slice(0, sample)) {
    const description = c.description.length > 40 ? `${c.description.slice(0, 39)}…` : c.description;
    console.log(`  ${description.padEnd(40)}  ${(c.from ?? "—").padEnd(20)} -> ${c.to.padEnd(22)} [${c.setId}]`);
  }

  if (!opts.write) console.log(`\nNothing written. Re-run with --write once this looks right.`);
}

main().catch((err: unknown) => {
  console.error("\ncategorise failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
