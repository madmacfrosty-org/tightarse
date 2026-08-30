/**
 * Household access, as an administrative command.
 *
 * Granting someone access was previously a thing you did by hand, which meant
 * it was undocumented, unrepeatable, and had no matching way to see who had
 * access or to take it away. For a store holding a family's complete financial
 * history, that is the wrong shape.
 *
 *   npm run access -w @tightarse/dynamodb -- list
 *   npm run access -w @tightarse/dynamodb -- grant someone@example.com frost
 *   npm run access -w @tightarse/dynamodb -- revoke someone@example.com
 *
 * The table comes from LEDGER_TABLE, and the AWS profile from the environment
 * as usual, so pointing this at the wrong account takes deliberate effort.
 *
 * Grant BEFORE the person first signs in. The pre-token trigger reads the
 * member row to set `custom:tenant`, and with no row it refuses — correctly,
 * since inventing a default would hand an unknown identity someone's ledger.
 * The symptom is a successful Google sign-in followed by "no household
 * assigned", which looks like a broken app rather than a missing row.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoStore } from "./dynamo-store";

const usage = `usage:
  access list
  access grant <email> <tenantId>
  access revoke <email>`;

async function main(): Promise<void> {
  const table = process.env["LEDGER_TABLE"];
  if (!table) throw new Error("Set LEDGER_TABLE to the ledger table name");

  const ledger = new DynamoStore({
    tableName: table,
    client: DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: process.env["AWS_REGION"] ?? "eu-west-1" }),
      { marshallOptions: { removeUndefinedValues: true } },
    ),
  });

  const [command, email, tenantId] = process.argv.slice(2);

  switch (command) {
    case "list": {
      const members = await ledger.listMembers();
      if (members.length === 0) {
        console.log("nobody has access");
        return;
      }
      for (const m of members) {
        console.log(
          `${m.email}\t${m.tenantId}\tadded ${m.addedAt ?? "unknown"}`,
        );
      }
      return;
    }

    case "grant": {
      if (!email || !tenantId) throw new Error(usage);
      // Deliberately loud. This is the whole authorisation model in one row:
      // whoever holds this email at the identity provider sees every
      // transaction in the household.
      const existing = await ledger.getMemberTenant(email);
      if (existing && existing !== tenantId) {
        throw new Error(
          `${email} already belongs to household "${existing}". Revoke first if the move is intended.`,
        );
      }
      await ledger.putMember({
        email: email.trim().toLowerCase(),
        tenantId,
        addedAt: new Date().toISOString(),
      });
      console.log(
        `granted ${email.trim().toLowerCase()} access to household ${tenantId}`,
      );
      console.log(
        "they will see every transaction in it, including everyone else's",
      );
      return;
    }

    case "revoke": {
      if (!email) throw new Error(usage);
      const existing = await ledger.getMemberTenant(email);
      if (!existing) {
        console.log(`${email} had no access; nothing to do`);
        return;
      }
      await ledger.deleteMember(email);
      console.log(`revoked ${email} from household ${existing}`);
      // Worth saying plainly, because the opposite is easy to assume.
      console.log("any token already issued keeps its claim until it expires");
      return;
    }

    default:
      throw new Error(usage);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
