/**
 * One-shot: write `nature` onto every category that lacks one.
 *
 * Exists so `kind` can be deleted. Derives the same value `natureOf` derives at
 * read time, so it changes no behaviour — it only moves the derivation from
 * every read to one write. **Delete this file once it has run.**
 *
 * `liability` is deliberately not inferred: `kind` cannot express a loan, so
 * anything that is one has to be said by hand afterwards.
 *
 *   LEDGER_TABLE=... TENANT=... node scripts/backfill-nature.mjs [--write]
 *
 * Dry by default. Prints what it would do and changes nothing without --write.
 */
import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
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

const natureOf = (kind) =>
  kind === "income" ? "income" : kind === "movement" ? "asset" : "expense";

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

const todo = rows.filter((r) => r.nature === undefined);
console.log(`${rows.length} categories, ${todo.length} without a nature`);
for (const r of todo) {
  const nature = natureOf(r.kind);
  console.log(`  ${r.id}: kind=${r.kind} -> nature=${nature}`);
  if (write) {
    await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: { pk: r.pk, sk: r.sk },
        UpdateExpression: "SET #n = :n",
        ExpressionAttributeNames: { "#n": "nature" },
        ExpressionAttributeValues: { ":n": nature },
        ConditionExpression: "attribute_exists(pk)",
      }),
    );
  }
}
console.log(write ? "written" : "dry run — pass --write to apply");
