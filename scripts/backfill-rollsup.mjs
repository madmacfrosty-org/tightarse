/**
 * One-shot: stop counting Transfer as money the household still holds.
 *
 * A transfer is not spending, so its nature is `asset` — but where the money
 * went is the one thing a transfer does not say. It may be an account we
 * already read, one we hold and do not fetch, or somebody else. Counting it as
 * held double-counts the first and invents the last.
 *
 * Sets `rollsUp: false` on any category the seed marks that way. **Delete this
 * file once it has run.**
 *
 *   LEDGER_TABLE=... TENANT=... node scripts/backfill-rollsup.mjs [--write]
 *
 * Dry by default.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const table = process.env.LEDGER_TABLE;
const tenant = process.env.TENANT;
const write = process.argv.includes("--write");
if (!table || !tenant) {
  console.error("LEDGER_TABLE and TENANT are required");
  process.exit(1);
}

/** Ids the seed keeps out of the household's position. */
const NOT_WORTH = new Set(["transfer"]);

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const rows = [];
let start;
do {
  const page = await doc.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
      ExpressionAttributeValues: { ":pk": `T#${tenant}`, ":sk": "CATEGORY#" },
      ExclusiveStartKey: start,
    }),
  );
  rows.push(...(page.Items ?? []));
  start = page.LastEvaluatedKey;
} while (start);

const todo = rows.filter((r) => NOT_WORTH.has(r.id) && r.rollsUp === undefined);
console.log(`${rows.length} categories, ${todo.length} to mark`);
for (const r of todo) {
  console.log(`  ${r.id}: rollsUp -> false`);
  if (write) {
    await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: { pk: r.pk, sk: r.sk },
        UpdateExpression: "SET rollsUp = :f",
        ExpressionAttributeValues: { ":f": false },
        ConditionExpression: "attribute_exists(pk)",
      }),
    );
  }
}
console.log(write ? "written" : "dry run — pass --write to apply");
