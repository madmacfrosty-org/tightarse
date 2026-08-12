import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import {
  TrueLayerClient,
  TrueLayerError,
  LIVE,
  SANDBOX,
  PER_ITEM_ENDPOINTS,
  RESOURCES,
  MAX_HISTORY_MONTHS,
  historyFrom,
  itemDataset,
  listDataset,
  transactionsDataset,
  type Resource,
} from "@tightarse/truelayer";
import { rawObjectKey } from "@tightarse/schema";
import { Connections, daysUntilExpiry, type Connection } from "./connections.js";

/**
 * The sync, decomposed into steps a state machine can retry individually.
 *
 * The previous version was one Lambda looping connections, resources and items.
 * A transient failure on one account was recorded and the run moved on — so
 * that account stayed stale until the next day's schedule. Per-item steps let
 * Step Functions retry the failing item in seconds instead.
 *
 * Granularity stops at the item. One step per endpoint would give a prettier
 * execution graph and a great deal more IAM and cold starts for no additional
 * recoverability.
 */

const sm = new SecretsManagerClient({});
const s3 = new S3Client({});

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

async function client(): Promise<TrueLayerClient> {
  const raw = await sm.send(new GetSecretValueCommand({ SecretId: required("CLIENT_SECRET_ID") }));
  const creds = JSON.parse(raw.SecretString ?? "{}") as { clientId: string; clientSecret: string };
  return new TrueLayerClient(creds, process.env["TL_ENV"] === "sandbox" ? SANDBOX : LIVE);
}

function connections(): Connections {
  return new Connections(required("CONNECTION_SECRET_PREFIX"), sm);
}

// ------------------------------------------------------------------ listing

/**
 * Step 1: the connections to sync.
 *
 * Every connection for the household by default — that is the daily run. A
 * connect passes the one it just created, so adding a second card does not
 * spend the other connections' unattended-call budget (four per 24 hours, per
 * consent) or give an unrelated failure a chance to muddy the execution that
 * matters. With one connection this was free; with a household holding several
 * it is not.
 *
 * Takes the whole execution input rather than a named field so an execution
 * started with no input at all still works — Step Functions defaults that to
 * `{}`, whereas a missing JSONPath reference is an error.
 */
export async function listConnections(args: {
  input?: { connectionId?: string };
}): Promise<{ connections: Connection[] }> {
  const all = await connections().list(required("TENANT_ID"));
  return { connections: selectConnections(all, args?.input) };
}

/** The scoping rule on its own, so it can be tested without Secrets Manager. */
export function selectConnections(
  all: readonly Connection[],
  input?: { connectionId?: string },
): Connection[] {
  const only = input?.connectionId;
  if (!only) return [...all];

  const one = all.filter((c) => c.connectionId === only);
  // A connectionId matching nothing means the caller believes in a connection
  // that is not there. Falling back to "sync everything" would look like
  // success while doing something else entirely.
  if (one.length === 0) throw new Error(`No connection ${only} for this household`);
  return one;
}

// ------------------------------------------------------------------ refresh

export interface RefreshOutput {
  connection: Connection;
  accessToken: string;
  items: Array<{ resource: Resource; itemId: string }>;
  skipped: string[];
  consentExpired: boolean;
  daysUntilConsentExpiry: number;
}

/**
 * Step 2: refresh the token and discover what there is to fetch.
 *
 * Also lands the account and card lists, since they are fetched here anyway.
 *
 * A lapsed consent returns rather than throwing. Only a human reconnecting at
 * the bank can fix it, and a thrown error would be retried by the state machine
 * for no purpose.
 */
export async function refreshAndList(input: { connection: Connection }): Promise<RefreshOutput> {
  const tl = await client();
  const conns = connections();
  const { connection } = input;

  let tokens;
  try {
    tokens = await tl.refresh(connection.refreshToken);
  } catch (err) {
    if (err instanceof TrueLayerError && err.isConsentExpired) {
      return {
        connection,
        accessToken: "",
        items: [],
        skipped: [],
        consentExpired: true,
        daysUntilConsentExpiry: daysUntilExpiry(connection),
      };
    }
    throw err;
  }

  // Persist immediately: a rotated refresh token that is not saved kills the
  // connection on the next run.
  const updated: Connection = { ...connection, refreshToken: tokens.refreshToken };
  await conns.update(updated);

  const items: Array<{ resource: Resource; itemId: string }> = [];
  const skipped: string[] = [];

  for (const resource of RESOURCES) {
    try {
      const res = await tl.get(tokens.accessToken, `/data/v1/${resource}`);
      await land(connection.tenantId, listDataset(resource), null, res.body);
      for (const a of (res.body as { results?: Array<{ account_id?: string }> }).results ?? []) {
        if (a.account_id) items.push({ resource, itemId: a.account_id });
      }
    } catch (err) {
      // A provider may offer only one of the two — Amex is cards-only, with no
      // accounts scope at all. A missing resource is a shape, not a failure.
      if (err instanceof TrueLayerError && err.isNotApplicable) {
        skipped.push(resource);
        continue;
      }
      throw err;
    }
  }

  return {
    connection: updated,
    accessToken: tokens.accessToken,
    items,
    skipped,
    consentExpired: false,
    daysUntilConsentExpiry: daysUntilExpiry(connection),
  };
}

// -------------------------------------------------------------------- fetch

export interface FetchInput {
  tenantId: string;
  accessToken: string;
  resource: Resource;
  itemId: string;
  historyMonths?: number;
}

/**
 * Step 3: everything for one account or card.
 *
 * This is the unit the state machine retries. It throws on a genuine failure so
 * the retry policy applies; endpoints the provider does not offer are reported
 * as skipped, because retrying a 501 forever helps nobody.
 */
export async function fetchItem(input: FetchInput): Promise<{ objects: number; skipped: string[] }> {
  const tl = await client();
  const { tenantId, accessToken, resource, itemId } = input;
  const now = new Date();
  const from = historyFrom(input.historyMonths ?? MAX_HISTORY_MONTHS, now);
  const to = now.toISOString().slice(0, 10);

  let objects = 0;
  const skipped: string[] = [];

  // Transactions first: they are the point of the exercise.
  const txRes = await tl.get(
    accessToken,
    `/data/v1/${resource}/${itemId}/transactions?from=${from}&to=${to}`,
  );
  await land(tenantId, transactionsDataset(resource), itemId, txRes.body, { from, to });
  objects += 1;

  const detail = await tl.get(accessToken, `/data/v1/${resource}/${itemId}`);
  await land(tenantId, itemDataset(resource), itemId, detail.body);
  objects += 1;

  for (const spec of PER_ITEM_ENDPOINTS) {
    if (!spec.resources.includes(resource)) continue;
    const dataset = spec.dataset(resource);
    try {
      const res = await tl.get(accessToken, `/data/v1/${resource}/${itemId}/${spec.suffix}`);
      await land(tenantId, dataset, itemId, res.body);
      objects += 1;
    } catch (err) {
      if (spec.optional && err instanceof TrueLayerError && err.isNotApplicable) {
        // First Direct returns 501 for standing orders everywhere and 403 for
        // direct debits on accounts that have none. Alarming on those trains
        // everyone to ignore alarms.
        skipped.push(`${dataset} ${itemId}`);
        continue;
      }
      throw err;
    }
  }

  return { objects, skipped };
}

// ------------------------------------------------------------------ outcome

export interface OutcomeInput {
  connection: Connection;
  consentExpired?: boolean;
  daysUntilConsentExpiry?: number;
  results?: Array<{ objects?: number; skipped?: string[]; Error?: string; Cause?: string }>;
}

const NUDGE_DAYS = 10;

/**
 * Final step: record what happened and raise anything a human must act on.
 *
 * Runs whether or not items failed, so a partial sync still updates
 * lastSyncedAt and still warns about an expiring consent.
 */
export async function recordOutcome(input: OutcomeInput): Promise<{ problems: string[] }> {
  const { connection } = input;
  const problems: string[] = [];
  const results = input.results ?? [];

  if (input.consentExpired) {
    problems.push(`Consent for ${connection.connectionId} has expired — reconnect at the bank.`);
  } else {
    await connections().update({ ...connection, lastSyncedAt: new Date().toISOString() });
  }

  const failed = results.filter((r) => r.Error);
  for (const f of failed) problems.push(`${connection.connectionId}: ${f.Error} ${f.Cause ?? ""}`.trim());

  const days = input.daysUntilConsentExpiry ?? daysUntilExpiry(connection);
  // Warn before it breaks. Reconfirmation needs a person at a browser, so a
  // day-of alert is already too late.
  if (!input.consentExpired && days <= NUDGE_DAYS && days >= 0) {
    problems.push(
      `Consent for ${connection.connectionId} expires in ${days} day(s) — reconfirm to keep the feed alive.`,
    );
  }

  // Counts only. A transaction body must never reach CloudWatch.
  console.log(
    JSON.stringify({
      connectionId: connection.connectionId,
      items: results.length,
      failed: failed.length,
      objects: results.reduce((n, r) => n + (r.objects ?? 0), 0),
      daysUntilConsentExpiry: days,
    }),
  );

  const topic = process.env["ALERT_TOPIC_ARN"];
  if (problems.length > 0 && topic) {
    await new SNSClient({}).send(
      new PublishCommand({
        TopicArn: topic,
        Subject: "Tightarse: attention needed",
        Message: problems.join("\n"),
      }),
    );
  }
  return { problems };
}

// -------------------------------------------------------------------- shared

async function land(
  tenantId: string,
  dataset: string,
  accountId: string | null,
  body: unknown,
  params: Record<string, string> = {},
): Promise<void> {
  const fetchedAt = new Date().toISOString();
  const payload = JSON.stringify({
    captureVersion: 1,
    environment: process.env["TL_ENV"] ?? "live",
    endpoint: dataset,
    params,
    accountId,
    fetchedAt,
    httpStatus: 200,
    body,
  });
  await s3.send(
    new PutObjectCommand({
      Bucket: required("RAW_BUCKET"),
      Key: rawObjectKey({
        tenantId,
        dataset,
        accountId: accountId ?? undefined,
        fetchedAt,
        contentHash: createHash("sha256").update(payload).digest("hex"),
      }),
      Body: gzipSync(Buffer.from(payload), { level: 9 }),
      ContentType: "application/json",
      ContentEncoding: "gzip",
      Tagging: new URLSearchParams({ tenant: tenantId, layer: "raw", dataset }).toString(),
    }),
  );
}
