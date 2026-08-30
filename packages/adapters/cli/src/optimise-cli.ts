/**
 * Report what the rules do, and optionally improve them.
 *
 *   TENANT=frost TABLE=<name> npm run optimise -w @tightarse/schedule
 *   ... -- --resolve-conflicts            propose fixes, still writing nothing
 *   ... -- --set built-in --rule 4 --pattern '<new>'   change one rule
 *   ... -- --file proposal.json           supply whole sets
 *   ... -- --propose                      record the proposal, decide later
 *   ... -- --accept                       record it and publish it
 *   ... -- --auto                          publish only if it is unambiguously better
 *
 * Rules are data. Narrowing a pattern that matched motorway services when it
 * meant fuel is an operational act — a proposal measured against the real
 * ledger and accepted or not — rather than a code change and a deploy.
 *
 * With no proposer it is the diagnostic: what the rules reach, where they
 * collide, and what nothing matches. Dry throughout unless --accept is given,
 * because a rule change alters what every matching transaction says and, under
 * re-application, changes history with it.
 */

import { DynamoStore } from "@tightarse/dynamodb";
import {
  candidateOf,
  currentSets,
  decide,
  mayApproveAutomatically,
  noProposals,
  optimise,
  propose,
  reviewOverrides,
  type OptimiseReport,
  type RuleProposer,
} from "@tightarse/domain";
import { conflictResolver } from "@tightarse/domain";
import { editing, replacing } from "@tightarse/domain";
import { readFileSync } from "node:fs";
import { RuleSet } from "@tightarse/domain";

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
  const accepting = process.argv.includes("--accept");

  const ledger = new DynamoStore({ tableName, region });
  const proposer = chooseProposer();
  const report = await optimise(
    { transactions: ledger, ruleSets: ledger, categories: ledger, proposer },
    tenantId,
    { range: { from, to } },
  );

  print(report);

  // Corrections, judged against what the rules would say without them. Here
  // rather than in `rules`, because it needs the corpus.
  const sets = (await ledger.listRuleSets(tenantId)).map((r) => RuleSet.parse(r));
  const { transactions } = await ledger.listRange(tenantId, { from, to });
  const review = reviewOverrides(sets, transactions.map(candidateOf));
  if (review.total > 0) {
    console.log(`\n${review.total} corrections:`);
    console.log(`  redundant      ${String(review.redundant.length).padStart(5)}  the rules now agree`);
    console.log(`  contradicted   ${String(review.contradicted.length).padStart(5)}  a rule is wrong`);
    console.log(`  orphaned       ${String(review.orphaned.length).padStart(5)}  no such transaction in range`);
    for (const c of review.contradicted.slice(0, 10)) {
      console.log(`    ${c.dedupKey}  you said ${c.corrected}, ${c.saidBy} says ${c.rulesSay}`);
    }
  }

  if (report.proposed.length === 0) return;

  const auto = process.argv.includes("--auto");
  const verdict = mayApproveAutomatically(report, await currentSets({ ruleSets: ledger }, tenantId));

  if (!accepting && !auto) {
    console.log(`\n  auto-approvable: ${verdict.allowed ? "yes" : "no"} — ${verdict.because}`);
    console.log(`\nNothing written. Re-run with --accept to record and publish, or --propose to record only.`);
    if (!process.argv.includes("--propose")) return;
  }

  if (auto && !verdict.allowed) {
    console.log(`\nNot auto-approved: ${verdict.because}`);
    console.log(`Recording the proposal for a person to decide.`);
  }

  // Recorded either way. A proposal that leaves no trace is one the next run
  // makes again, and the day after.
  const recorded = await propose({ ruleSets: ledger, categories: ledger }, tenantId, report.proposed, {
    now: new Date(),
    by: report.proposedBy,
  });
  console.log(`\nproposed:`);
  for (const p of recorded) console.log(`  ${p.setId.padEnd(12)} v${p.version}  ${p.rules} rules`);

  const publish = accepting || (auto && verdict.allowed);
  if (!publish) return;

  const decided = await decide({ ruleSets: ledger }, tenantId, recorded, { status: "effective" });
  console.log(`\npublished:`);
  for (const d of decided) console.log(`  ${d.setId.padEnd(12)} v${d.version} is now effective`);
}

/**
 * Which opinion to apply, if any.
 *
 * The default proposes nothing, so with no flags this is the diagnostic. Every
 * other route ends up in the same `optimise` call and faces the same before and
 * after — which is the point of the port.
 */
function chooseProposer(): RuleProposer {
  if (process.argv.includes("--resolve-conflicts")) return conflictResolver();

  const by = process.env["USER"] ?? "operator";

  // Whole sets from a file: the general form, and the one a model will produce.
  // It is how a rule moves BETWEEN sets, which an in-place edit cannot express —
  // and moving a rule down a set is how "only if nothing more specific matched"
  // is said, precedence being the mechanism for exactly that.
  const file = arg("file");
  if (file !== undefined) {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const sets = (Array.isArray(parsed) ? parsed : [parsed]).map((s) => RuleSet.parse(s));
    return replacing(sets, `${by} via ${file}`);
  }

  const set = arg("set");
  const index = arg("rule");
  if (set === undefined || index === undefined) return noProposals;

  const pattern = arg("pattern");
  const category = arg("category");
  const contributes = arg("contributes") as "assert" | "refine" | undefined;
  return editing(
    {
      setId: set,
      index: Number(index),
      ...(pattern === undefined ? {} : { pattern }),
      ...(category === undefined ? {} : { category }),
      ...(contributes === undefined ? {} : { contributes }),
    },
    by,
  );
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
