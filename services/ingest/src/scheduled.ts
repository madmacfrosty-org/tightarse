import { S3Client } from "@aws-sdk/client-s3";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { TrueLayerClient, LIVE, SANDBOX } from "@tightarse/truelayer";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { Connections, daysUntilExpiry } from "./connections.js";
import { syncConnection } from "./sync.js";

/**
 * The daily sync.
 *
 * Runs once a day, not hourly: unattended open banking access is capped at four
 * calls per 24 hours per consent, and a sync makes several per account.
 *
 * Also the consent watchdog. A lapsed consent stops the feed silently, so this
 * is the thing that notices — both when a refresh is refused and, earlier, when
 * expiry is close enough to act on.
 */

const NUDGE_DAYS = 10;

export async function handler(): Promise<{ synced: number; problems: string[] }> {
  const tenantId = required("TENANT_ID");
  const bucket = required("RAW_BUCKET");
  const secretPrefix = required("CONNECTION_SECRET_PREFIX");
  const clientSecretId = required("CLIENT_SECRET_ID");
  const topicArn = process.env["ALERT_TOPIC_ARN"];

  const sm = new SecretsManagerClient({});
  const raw = await sm.send(new GetSecretValueCommand({ SecretId: clientSecretId }));
  const creds = JSON.parse(raw.SecretString ?? "{}") as { clientId: string; clientSecret: string };

  const truelayer = new TrueLayerClient(creds, process.env["TL_ENV"] === "sandbox" ? SANDBOX : LIVE);
  const connections = new Connections(secretPrefix, sm);
  const deps = { truelayer, connections, s3: new S3Client({}), bucket };

  const all = await connections.list(tenantId);
  const problems: string[] = [];
  let synced = 0;

  for (const connection of all) {
    const days = daysUntilExpiry(connection);

    try {
      const result = await syncConnection(deps, connection);
      if (result.consentExpired) {
        problems.push(`Consent for ${connection.connectionId} has expired — reconnect at the bank.`);
        continue;
      }
      synced += 1;
      // Log counts, never transaction bodies. Descriptions are the sensitive
      // part and CloudWatch is not where they belong.
      console.log(
        JSON.stringify({
          connectionId: connection.connectionId,
          objects: result.objectsWritten,
          skipped: result.skipped.length,
          errors: result.errors.length,
          daysUntilConsentExpiry: days,
        }),
      );
      if (result.errors.length > 0) problems.push(...result.errors);
    } catch (err) {
      problems.push(`${connection.connectionId}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Warn before it breaks, not after. Reconfirmation needs a human at a
    // browser, so a day-of alert is already too late.
    if (days <= NUDGE_DAYS && days >= 0) {
      problems.push(`Consent for ${connection.connectionId} expires in ${days} day(s) — reconfirm to keep the feed alive.`);
    }
  }

  if (problems.length > 0 && topicArn) {
    await new SNSClient({}).send(
      new PublishCommand({
        TopicArn: topicArn,
        Subject: "Tightarse: attention needed",
        Message: problems.join("\n"),
      }),
    );
  }

  return { synced, problems };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}
