/**
 * Categorise the outstanding backlog.
 *
 * Reads transactions with no enrichment, classifies them in batches, and writes
 * one enrichment row each. Idempotent: an already-categorised transaction is
 * not in the backlog, so re-running costs nothing and a partial run resumes
 * where it stopped.
 *
 *   TENANT=frost TABLE=<name> node dist/run.js [--limit N] [--from D] [--to D] [--dry-run]
 */

import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { Ledger } from "@tightarse/ledger";
import { classifyBatch, DEFAULT_MODEL } from "./bedrock.js";
import { RULES_VERSION } from "./rules.js";
import { prepare } from "./batch.js";
import type { Candidate } from "./categorise.js";

const BATCH_SIZE = 40;

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

  const ledger = new Ledger({ tableName, region });
  const bedrock = new BedrockRuntimeClient({ region });

  // Mode is an explicit household setting, not implied by whether this has run.
  // Defaulting is done here, at the call site, so the choice is visible.
  const settings = await ledger.getSettings(tenantId);
  const mode = (arg("mode") ?? settings?.enrichment ?? "model") as "off" | "rules" | "model";
  if (mode === "off") {
    console.log(`enrichment is "off" for ${tenantId} — provider payment type only. Nothing to do.`);
    return;
  }

  // Shared with the scheduled Lambda so the two cannot drift apart.
  const prepared = await prepare(ledger, tenantId, { from, to }, limit);
  const { candidates, timestamps, customRuleCount } = prepared;
  console.log(`${candidates.length} transactions awaiting categorisation  (mode ${mode}${mode === "model" ? `, ${modelId}` : ""})\n`);
  if (candidates.length === 0) return;
  if (customRuleCount > 0) console.log(`${customRuleCount} custom rules loaded`);

  const ruled = { classifications: prepared.classifications, unmatched: prepared.unmatched };
  console.log(
    `rules matched ${ruled.classifications.length}/${candidates.length}` +
      ` (${((ruled.classifications.length / candidates.length) * 100).toFixed(1)}%)` +
      `, ${ruled.unmatched.length} left for the model\n`,
  );

  let written = 0;
  let rejected = 0;
  let missing = 0;
  let inTok = 0;
  let outTok = 0;
  const tally = new Map<string, number>();
  const samples: Array<{
    description: string;
    amount: number;
    providerCategory?: string | undefined;
    category: string;
    confidence: number;
  }> = [];
  const producedBy = `categoriser@${modelId}`;
  const producedAt = new Date().toISOString();

  // Write the rule-derived enrichments first so a later failure still leaves
  // the deterministic half done.
  for (const c of ruled.classifications) {
    tally.set(c.category, (tally.get(c.category) ?? 0) + 1);
    if (dryRun) {
      const b = candidates.find((x) => x.dedupKey === c.dedupKey);
      samples.push({
        description: b?.description ?? "",
        amount: b?.amount ?? 0,
        providerCategory: b?.providerCategory,
        category: c.category,
        confidence: c.confidence,
      });
      continue;
    }
    const timestamp = timestamps.get(c.dedupKey);
    if (!timestamp) continue;
    await ledger.putEnrichment({
      tenantId,
      dedupKey: c.dedupKey,
      timestamp,
      category: c.category,
      confidence: c.confidence,
      producedBy: RULES_VERSION,
      producedAt,
    });
    written += 1;
  }

  const forModel = mode === "model" ? ruled.unmatched : [];
  for (let i = 0; i < forModel.length; i += BATCH_SIZE) {
    const batch = forModel.slice(i, i + BATCH_SIZE);
    const res = await classifyBatch(bedrock, batch, modelId);
    inTok += res.inputTokens;
    outTok += res.outputTokens;
    rejected += res.rejected;
    missing += res.missing;

    const byKey = new Map(batch.map((b) => [b.dedupKey, b]));
    for (const c of res.classifications) {
      tally.set(c.category, (tally.get(c.category) ?? 0) + 1);
      if (dryRun) {
        // Print every assignment, not just the totals. A distribution can look
        // entirely plausible while individual rows are wrong, and the whole
        // point of a sample is to catch that before spending on 9,653.
        const b = byKey.get(c.dedupKey);
        samples.push({
          description: b?.description ?? "",
          amount: b?.amount ?? 0,
          providerCategory: b?.providerCategory,
          category: c.category,
          confidence: c.confidence,
        });
        continue;
      }
      const timestamp = timestamps.get(c.dedupKey);
      if (!timestamp) continue;
      await ledger.putEnrichment({
        tenantId,
        dedupKey: c.dedupKey,
        timestamp,
        category: c.category,
        confidence: c.confidence,
        producedBy,
        producedAt,
      });
      written += 1;
    }

    const done = Math.min(i + BATCH_SIZE, forModel.length);
    process.stdout.write(`\r  model: ${done}/${forModel.length}`);
  }

  console.log(`\n\n${dryRun ? "would write" : "wrote"} ${dryRun ? ruled.classifications.length + forModel.length - missing : written} enrichments`);
  if (rejected > 0) console.log(`  ${rejected} responses outside the taxonomy, stored as Other`);
  if (missing > 0) console.log(`  ${missing} left in the backlog (no response)`);
  console.log(`  tokens: ${inTok} in, ${outTok} out`);

  if (dryRun && samples.length > 0) {
    console.log(`\nassignments (lowest confidence first — where errors hide):\n`);
    const sorted = [...samples].sort((a, b) => a.confidence - b.confidence);
    for (const s of sorted) {
      const amt = (s.amount / 100).toFixed(2).padStart(10);
      const desc = s.description.length > 38 ? `${s.description.slice(0, 37)}…` : s.description;
      console.log(
        `  ${s.confidence.toFixed(2)}  ${amt}  ${desc.padEnd(38)}  ${s.category.padEnd(22)}${s.providerCategory ?? ""}`,
      );
    }
  }

  console.log(`\ncategories assigned:`);
  for (const [c, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.padEnd(24)} ${String(n).padStart(5)}`);
  }
}

main().catch((err: unknown) => {
  console.error("\ncategoriser failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
