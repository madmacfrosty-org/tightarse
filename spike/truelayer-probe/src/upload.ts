/**
 * Split a probe capture into one object per API response and upload to the raw
 * landing zone.
 *
 * One object per response, not one per run: that is what makes the event-driven
 * transform work. Each ObjectCreated event carries a single response, so the
 * transform parallelises, a failure isolates to one response instead of the
 * whole capture, and a replay can reprocess one dataset alone.
 *
 * Only successful responses are uploaded by default. Errors are not data: the
 * bulk of them are an artefact of the probe's depth ladder, which the
 * production fetcher will never reproduce, and every one would wake a
 * transform that has to recognise it as a no-op. The 403s and 501s are genuine
 * facts about the provider, but they belong in metrics, not in a landing zone
 * that every consumer would then have to filter past.
 *
 * Usage:
 *   TENANT=frost BUCKET=<name> node src/upload.ts out/raw-*.json [--dry-run] [--include-failures]
 */

import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { datasetForEndpoint, rawObjectKey } from "@tightarse/domain";

interface RawRecord {
  endpoint: string;
  params: Record<string, string>;
  accountId: string | null;
  fetchedAt: string;
  httpStatus: number;
  body: unknown;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const tenantId = requireEnv("TENANT");
  const bucket = requireEnv("BUCKET");
  const region = process.env["AWS_REGION"] ?? "eu-west-1";
  const file = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  const includeFailures = process.argv.includes("--include-failures");

  if (!file) {
    console.error("usage: node src/upload.ts <capture.json> [--dry-run]");
    process.exit(1);
  }

  const capture = JSON.parse(await readFile(file, "utf8")) as {
    captureVersion: number;
    capturedAt: string;
    environment: string;
    consentAt?: string;
    records: RawRecord[];
  };

  const records = includeFailures
    ? capture.records
    : capture.records.filter((r) => r.httpStatus >= 200 && r.httpStatus < 300);

  console.log(`capture v${capture.captureVersion} from ${capture.capturedAt}`);
  console.log(
    `${records.length} of ${capture.records.length} responses -> s3://${bucket}` +
      (includeFailures ? " (including failures)" : " (2xx only)") + "\n",
  );

  const s3 = new S3Client({ region });
  let uploaded = 0;
  let bytesIn = 0;
  let bytesOut = 0;

  for (const record of records) {
    const dataset = datasetForEndpoint(record.endpoint);

    // The object is the response plus its provenance — endpoint, params, when
    // and what status. Without that a replay would have to guess what it was
    // looking at.
    const payload = JSON.stringify({
      captureVersion: capture.captureVersion,
      environment: capture.environment,
      consentAt: capture.consentAt ?? null,
      endpoint: record.endpoint,
      params: record.params,
      accountId: record.accountId,
      fetchedAt: record.fetchedAt,
      httpStatus: record.httpStatus,
      body: record.body,
    });

    const gz = gzipSync(Buffer.from(payload), { level: 9 });
    const hash = createHash("sha256").update(payload).digest("hex");
    const key = rawObjectKey({
      tenantId,
      dataset,
      accountId: record.accountId ?? undefined,
      fetchedAt: record.fetchedAt,
      contentHash: hash,
    });

    bytesIn += payload.length;
    bytesOut += gz.length;

    const results = (record.body as { results?: unknown[] })?.results;
    const n = Array.isArray(results) ? results.length : 0;
    console.log(`  ${String(n).padStart(5)} items  ${(gz.length / 1024).toFixed(0).padStart(5)}KB  ${key}`);

    if (dryRun) continue;

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: gz,
        ContentType: "application/json",
        ContentEncoding: "gzip",
        // Tags drive lifecycle filtering and tag-based erasure via S3 Batch
        // Operations, which works regardless of how the prefix is laid out.
        Tagging: new URLSearchParams({
          tenant: tenantId,
          layer: "raw",
          dataset,
        }).toString(),
        Metadata: {
          endpoint: record.endpoint,
          "fetched-at": record.fetchedAt,
          "http-status": String(record.httpStatus),
          "capture-version": String(capture.captureVersion),
        },
      }),
    );
    uploaded += 1;
  }

  console.log(
    `\n${dryRun ? "[dry run] would upload" : "uploaded"} ${dryRun ? records.length : uploaded} objects` +
      `  ${(bytesIn / 1e6).toFixed(1)}MB -> ${(bytesOut / 1e6).toFixed(1)}MB gzipped`,
  );
}

main().catch((err: unknown) => {
  console.error("upload failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
