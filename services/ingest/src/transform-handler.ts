import { S3Client } from "@aws-sdk/client-s3";
import { Ledger } from "@tightarse/ledger";
import { transformObject } from "@tightarse/transform";

/**
 * EventBridge handler: one raw object in, ledger rows out.
 *
 * EventBridge rather than an S3 notification because the bucket and this
 * function live in different stacks, and a notification would make each depend
 * on the other. It also matches keys more flexibly than notification filters,
 * which are literal prefix and suffix only.
 *
 * One object per event, so a failure isolates to a single response and a replay
 * can target one dataset. Every write is idempotent, so a retry is harmless.
 */

const s3 = new S3Client({});
const bucket = process.env["RAW_BUCKET"] ?? "";
const ledger = new Ledger({
  tableName: process.env["TABLE_NAME"] ?? "",
  region: process.env["AWS_REGION"] ?? "eu-west-1",
});

interface ObjectCreated {
  detail: { object: { key: string } };
}

export async function handler(event: ObjectCreated): Promise<void> {
  // EventBridge delivers the key URL-encoded, and ours contain '=' and can
  // contain characters that only survive a round trip once decoded.
  const key = decodeURIComponent(event.detail.object.key.replace(/\+/g, " "));
  const result = await transformObject({ s3, ledger, bucket }, key);
  // Counts only — a transaction body must never reach CloudWatch.
  console.log(JSON.stringify({ dataset: result.dataset, handler: result.handler, rows: result.rows }));
}
