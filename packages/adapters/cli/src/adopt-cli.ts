/**
 * Give a tenant the adoption list it has been running without.
 *
 * One-shot, for #121. Precedence used to be a number on each rule set; it is
 * now a position in the list of sets a tenant adopted, and a tenant without a
 * list adopts nothing — which categorises nothing. Seeding writes the list for
 * a tenant onboarded from now on. This is for the ones already there.
 *
 *   TENANT=frost TABLE=<name> npm run adopt -w @tightarse/cli          # report
 *   TENANT=frost TABLE=<name> npm run adopt -w @tightarse/cli -- --write
 *
 * Reports by default and writes only when asked, because it is the file that
 * decides what every category in the ledger becomes.
 *
 * **Delete this once every tenant has a list.** A migration kept around is a
 * second way to write a value that should only ever be written one way.
 */

import { DynamoStore } from "@tightarse/dynamodb";
import { RuleSet, seedAdoptions } from "@tightarse/domain";

async function main() {
  const tenantId = process.env["TENANT"] ?? "frost";
  const tableName = process.env["TABLE"];
  if (!tableName) {
    console.error("Missing TABLE");
    process.exit(1);
  }

  const ledger = new DynamoStore({
    tableName,
    region: process.env["AWS_REGION"] ?? "eu-west-1",
  });

  const existing = await ledger.getAdoptions(tenantId);
  if (existing.length > 0) {
    console.log(
      `${tenantId} already adopts, most trusted first: ` +
        existing.map((a) => `${a.setId} v${a.version}`).join(" > "),
    );
    console.log("Nothing to do.");
    return;
  }

  // Highest version per set, and only what is actually in force. Adopting a
  // proposed version would put rules nobody accepted into every total.
  const inForce = new Map<string, RuleSet>();
  for (const row of await ledger.listRuleSets(tenantId)) {
    const parsed = RuleSet.safeParse(row);
    if (!parsed.success || parsed.data.status !== "effective") continue;
    const seen = inForce.get(parsed.data.setId);
    if (seen === undefined || parsed.data.version > seen.version)
      inForce.set(parsed.data.setId, parsed.data);
  }

  const adoptions = seedAdoptions(tenantId, [...inForce.values()], new Date());
  if (adoptions.length === 0) {
    console.error(`${tenantId} has no effective rule sets. Seed it first.`);
    process.exit(1);
  }

  console.log(`${tenantId} would adopt, most trusted first:`);
  for (const a of adoptions) console.log(`  ${a.setId.padEnd(14)} v${a.version}`);

  if (!process.argv.includes("--write")) {
    console.log("\nReported, not written. Re-run with --write.");
    return;
  }
  await ledger.putAdoptions(tenantId, adoptions);
  console.log("\nWritten. Re-run a categorisation for it to take effect.");
}

main().catch((err: unknown) => {
  console.error("\nadopt failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
