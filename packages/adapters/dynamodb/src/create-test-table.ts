/**
 * Create or destroy an ephemeral ledger table for the integration tests.
 *
 *   npm run create-test-table -w @tightarse/dynamodb          # create, then wait
 *   npm run create-test-table -w @tightarse/dynamodb -- --delete
 *
 * Ten tests — idempotency, the account-merge rules, the balance write that must
 * not erase an institution name — were skipping on every push for want of a
 * table. Tests that never run are worse than no tests: they are a green tick
 * that means nothing.
 *
 * Both directions go through `resolveTestTarget`, which is what stops either
 * one reaching the household ledger. Deletion matters more than creation there:
 * creating over the real table fails harmlessly as ResourceInUseException,
 * whereas deleting it destroys five years of transactions that no amount of
 * retrying gets back. The CI credential is restricted the same way, so a
 * mistake has to defeat both.
 *
 * The schema is kept in step with `infra/lib/data-stack.ts` by hand. There is
 * no way to have CDK emit it without a deploy, so a mismatch is possible; the
 * tests fail loudly if it drifts, which is the intended safety net.
 */
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  ResourceInUseException,
  ResourceNotFoundException,
  waitUntilTableExists,
  waitUntilTableNotExists,
} from "@aws-sdk/client-dynamodb";
import { resolveTestTarget } from "./test-table";

/**
 * A refusal here is the guard working, so it prints the reason and nothing
 * else. Letting it throw from module scope buries a one-line explanation under
 * a stack trace, which is how a safety message gets skimmed past.
 */
function target(): ReturnType<typeof resolveTestTarget> {
  try {
    return resolveTestTarget(process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

const { tableName, region, endpoint } = target();

const client = new DynamoDBClient({
  ...(endpoint ? { endpoint } : {}),
  region,
  // DynamoDB Local validates that credentials exist, not what they are. Against
  // real DynamoDB these must NOT be supplied, or the ambient profile is ignored
  // and every call fails as UnrecognizedClientException.
  ...(endpoint
    ? { credentials: { accessKeyId: "local", secretAccessKey: "local" } }
    : {}),
});

const where = endpoint ?? `real DynamoDB in ${region}`;

async function create(): Promise<void> {
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
    console.log(`created ${tableName} at ${where}`);
  } catch (err) {
    // Re-running against a live container is normal, not a failure.
    if (err instanceof ResourceInUseException) {
      console.log(`${tableName} already exists at ${where}`);
    } else {
      throw err;
    }
  }

  // Real DynamoDB returns from CreateTable while the table is still CREATING,
  // and a query against it fails as ResourceNotFoundException. The emulator is
  // immediate, so this is the difference that made the suite pass locally and
  // fail on its first real-AWS run.
  await waitUntilTableExists(
    { client, maxWaitTime: 120 },
    { TableName: tableName },
  );

  const described = await client.send(
    new DescribeTableCommand({ TableName: tableName }),
  );
  console.log(`status: ${described.Table?.TableStatus}`);
}

async function destroy(): Promise<void> {
  try {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
  } catch (err) {
    // Nothing to delete is the desired end state, not an error. This runs in an
    // `always()` step, so it also fires when table creation itself failed.
    if (err instanceof ResourceNotFoundException) {
      console.log(`${tableName} does not exist at ${where}`);
      return;
    }
    throw err;
  }
  await waitUntilTableNotExists(
    { client, maxWaitTime: 120 },
    { TableName: tableName },
  );
  console.log(`deleted ${tableName} at ${where}`);
}

// Not top-level await: this package compiles under a module setting that does
// not allow it, and the failure only shows up in `tsc`, not in the test run.
const run = process.argv.includes("--delete") ? destroy : create;
run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
