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

  const backlog = await ledger.listToEnrich(tenantId, { from, to }, limit);
  console.log(`${backlog.length} transactions awaiting categorisation  (model ${modelId})\n`);
  if (backlog.length === 0) return;

  const candidates: Candidate[] = backlog.map((r) => ({
    dedupKey: String(r["dedupKey"]),
    description: String(r["description"] ?? ""),
    amount: Number(r["amount"] ?? 0),
    currency: String(r["currency"] ?? "GBP"),
    ...(r["providerCategory"] ? { providerCategory: String(r["providerCategory"]) } : {}),
  }));

  const timestamps = new Map(backlog.map((r) => [String(r["dedupKey"]), String(r["timestamp"])]));

  let written = 0;
  let rejected = 0;
  let missing = 0;
  let inTok = 0;
  let outTok = 0;
  const tally = new Map<string, number>();
  const producedBy = `categoriser@${modelId}`;
  const producedAt = new Date().toISOString();

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const res = await classifyBatch(bedrock, batch, modelId);
    inTok += res.inputTokens;
    outTok += res.outputTokens;
    rejected += res.rejected;
    missing += res.missing;

    for (const c of res.classifications) {
      tally.set(c.category, (tally.get(c.category) ?? 0) + 1);
      if (dryRun) continue;
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

    const done = Math.min(i + BATCH_SIZE, candidates.length);
    process.stdout.write(`\r  ${done}/${candidates.length}`);
  }

  console.log(`\n\n${dryRun ? "would write" : "wrote"} ${dryRun ? candidates.length - missing : written} enrichments`);
  if (rejected > 0) console.log(`  ${rejected} responses outside the taxonomy, stored as Other`);
  if (missing > 0) console.log(`  ${missing} left in the backlog (no response)`);
  console.log(`  tokens: ${inTok} in, ${outTok} out`);

  console.log(`\ncategories assigned:`);
  for (const [c, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.padEnd(24)} ${String(n).padStart(5)}`);
  }
}

main().catch((err: unknown) => {
  console.error("\ncategoriser failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
