/**
 * Seed the categorisation model: categories, and the rules in service today.
 *
 *   TENANT=frost TABLE=<name> npm run seed -w @tightarse/categoriser
 *   ... -- --write           record the proposal
 *   ... -- --write --accept  record it and publish it
 *
 * Dry by default, and deliberately the wrong way round from the other commands.
 * Applying rules is reversible — re-application is total and idempotent, so a
 * bad run is fixed by fixing the rules and running again. Changing the rules is
 * the consequential act: it changes what every matching transaction says, and
 * under re-application it changes history with it.
 *
 * Reads the legacy single `RULES` item and leaves it exactly where it is. It is
 * the source being converted, and deleting a source during a migration removes
 * the only way to check the result.
 */

import { DynamoStore } from "@tightarse/dynamodb";
import { decide, propose, SEED_CATEGORIES, seedRuleSets } from "@tightarse/domain";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const tenantId = process.env["TENANT"] ?? "frost";
  const tableName = required("TABLE");
  const region = process.env["AWS_REGION"] ?? "eu-west-1";
  const write = process.argv.includes("--write");

  const ledger = new DynamoStore({ tableName, region });
  const custom = await ledger.getCustomRules(tenantId);
  const sets = seedRuleSets({ now: new Date(), custom });

  console.log(`${write ? "writing" : "would write"} for ${tenantId} in ${tableName}\n`);
  console.log(`${SEED_CATEGORIES.length} categories`);
  for (const s of sets) {
    console.log(
      `  ${String(s.order).padStart(2)}  ${s.setId.padEnd(12)} v${s.version}  ` +
        `${String(s.rules.length).padStart(3)} rules${s.authored ? "  (authored, never regenerated)" : ""}`,
    );
  }

  // Counts by category, not the patterns themselves. A pattern is derived from a
  // household's statements, and this output is read in a terminal that may be
  // shared or recorded.
  const byCategory = new Map<string, number>();
  for (const s of sets) {
    for (const r of s.rules) {
      if (r.contributes.kind !== "assert") continue;
      byCategory.set(r.contributes.category, (byCategory.get(r.contributes.category) ?? 0) + 1);
    }
  }
  console.log(`\nrules by category:`);
  for (const [c, n] of [...byCategory.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    console.log(`  ${c.padEnd(24)} ${String(n).padStart(3)}`);
  }

  if (!write) {
    console.log(`\nNothing written. Re-run with --write once this looks right.`);
    return;
  }

  // Categories first: a proposal naming one that does not exist is refused, and
  // on a first run none of them do.
  for (const c of SEED_CATEGORIES) await ledger.putCategory(tenantId, c);

  // Through the same door as every other rule change, so re-seeding after a fix
  // writes the next version rather than colliding with a published one.
  const recorded = await propose({ ruleSets: ledger, categories: ledger }, tenantId, sets, {
    now: new Date(),
    by: `seed:${process.env["USER"] ?? "operator"}`,
  });
  console.log(`\nwrote ${SEED_CATEGORIES.length} categories`);
  for (const r of recorded) console.log(`  ${r.setId.padEnd(12)} v${r.version} proposed  ${r.rules} rules`);

  if (!process.argv.includes("--accept")) {
    console.log(`\nProposed, not in force. Re-run with --write --accept to publish.`);
    return;
  }
  const decided = await decide({ ruleSets: ledger }, tenantId, recorded, { status: "effective" });
  for (const d of decided) console.log(`  ${d.setId.padEnd(12)} v${d.version} is now effective`);
}

main().catch((err: unknown) => {
  console.error("\nseed failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
