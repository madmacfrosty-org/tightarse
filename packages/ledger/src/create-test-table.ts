/**
 * Create the ledger table in DynamoDB Local, so the integration tests can run
 * in CI instead of skipping.
 *
 * Ten tests — idempotency, the account-merge rules, the balance write that must
 * not erase an institution name — were skipping on every push for want of a
 * table. Tests that never run are worse than no tests: they are a green tick
 * that means nothing.
 *
 * The schema is kept in step with `infra/lib/data-stack.ts` by hand. There is
 * no way to have CDK emit it without a deploy, so a mismatch is possible; the
 * tests fail loudly if it drifts, which is the intended safety net.
 */
import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  ResourceInUseException,
} from "@aws-sdk/client-dynamodb";

const endpoint = process.env["LEDGER_TEST_ENDPOINT"] ?? "http://localhost:8000";
const tableName = process.env["LEDGER_TEST_TABLE"] ?? "Ledger";

const client = new DynamoDBClient({
  endpoint,
  region: process.env["AWS_REGION"] ?? "eu-west-1",
  // DynamoDB Local validates that credentials exist, not what they are.
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});

async function main(): Promise<void> {
  try {
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
          { AttributeName: "gsi1pk", AttributeType: "S" },
          { AttributeName: "gsi1sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: "gsi1-account",
            KeySchema: [
              { AttributeName: "gsi1pk", KeyType: "HASH" },
              { AttributeName: "gsi1sk", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          },
        ],
      }),
    );
    console.log(`created ${tableName} at ${endpoint}`);
  } catch (err) {
    // Re-running against a live container is normal, not a failure.
    if (err instanceof ResourceInUseException) {
      console.log(`${tableName} already exists at ${endpoint}`);
    } else {
      throw err;
    }
  }

  const described = await client.send(new DescribeTableCommand({ TableName: tableName }));
  console.log(`status: ${described.Table?.TableStatus}`);
}

await main();
