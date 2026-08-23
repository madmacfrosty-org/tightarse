/**
 * Report what the rules do, and optionally improve them.
 *
 *   TENANT=frost TABLE=<name> npm run optimise -w @tightarse/categoriser
 *   ... -- --resolve-conflicts     propose fixes, still writing nothing
 *   ... -- --resolve-conflicts --accept   publish the proposal
 *
 * With no proposer it is the diagnostic: what the rules reach, where they
 * collide, and what nothing matches. Dry throughout unless --accept is given,
 * because a rule change alters what every matching transaction says and, under
 * re-application, changes history with it.
 */

import { DynamoStore } from "@tightarse/dynamodb";
import { accept, noProposals, optimise, type OptimiseReport } from "@tightarse/domain";
import { conflictResolver } from "./conflict-resolver.js";

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
  const from = arg("from") ?? "2021-01-01";
  const to = arg("to") ?? new Date().toISOString().slice(0, 10);
  const resolving = process.argv.includes("--resolve-conflicts");
  const accepting = process.argv.includes("--accept");

  const ledger = new DynamoStore({ tableName, region });
  const proposer = resolving ? conflictResolver() : noProposals;
  const report = await optimise({ transactions: ledger, ruleSets: ledger, proposer }, tenantId, {
    range: { from, to },
  });

  print(report);

  if (!accepting || report.proposed.length === 0) {
    if (report.proposed.length > 0) console.log(`\nNothing written. Re-run with --accept to publish.`);
    return;
  }

  const accepted = await accept({ ruleSets: ledger }, tenantId, report.proposed, {
    now: new Date(),
    by: report.proposedBy,
  });
  console.log(`\npublished:`);
  for (const a of accepted) console.log(`  ${a.setId.padEnd(12)} v${a.from} -> v${a.to}  ${a.rules} rules`);
}

function print(report: OptimiseReport): void {
  const { before } = report;
  console.log(`${report.scanned} transactions\n`);

  const dead = before.reach.filter((r) => r.transactions === 0);
  console.log(`  rules            ${String(before.reach.length).padStart(5)}`);
  console.log(`  never fire       ${String(dead.length).padStart(5)}`);
  console.log(`  conflicts        ${String(before.conflicts.length).padStart(5)}`);
  console.log(`  inert refines    ${String(before.inertRefines.length).padStart(5)}`);
  console.log(`  merchants unseen ${String(before.gaps.length).padStart(5)}`);

  if (before.conflicts.length > 0) {
    console.log(`\nconflicts, worst first:\n`);
    for (const c of before.conflicts.slice(0, 15)) {
      console.log(
        `  ${c.setId.padEnd(10)} rules ${c.rules.join(" vs ").padEnd(8)} ` +
          `${c.categories.join(" vs ").padEnd(34)} ${String(c.transactions).padStart(5)} tx   e.g. ${c.example}`,
      );
    }
  }

  if (dead.length > 0) {
    console.log(`\nrules matching nothing: ${dead.map((d) => `${d.setId}#${d.index}`).join(", ")}`);
  }

  if (report.improvement) {
    const i = report.improvement;
    console.log(`\nproposed by ${report.proposedBy}:\n`);
    const line = (name: string, v: { before: number; after: number }) =>
      console.log(`  ${name.padEnd(16)} ${String(v.before).padStart(5)} -> ${String(v.after).padStart(5)}`);
    line("conflicts", i.conflicts);
    line("inert refines", i.inertRefines);
    line("merchants unseen", i.gaps);
    line("never fire", i.deadRules);
    // Coverage getting worse is the risk of this change: converting an assert
    // to a refine changes that rule for every transaction it matches, not only
    // the ones in conflict.
    if (i.gaps.after > i.gaps.before) {
      console.log(`\n  WARNING: ${i.gaps.after - i.gaps.before} more merchants would match nothing.`);
    }
  }
}

main().catch((err: unknown) => {
  console.error("\noptimise failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
