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
  syncWindow,
  type SyncWindow,
  historyFrom,
  itemDataset,
  listDataset,
  transactionsDataset,
  type Resource,
} from "@tightarse/truelayer";
import { rawObjectKey } from "@tightarse/schema";
import { emit } from "@tightarse/metrics";
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

/**
 * Everything these steps reach outside themselves.
 *
 * Passed in rather than constructed here, so a test can supply fakes. This file
 * used to build its own Secrets Manager and S3 clients at module scope, which
 * made it untestable and left it at 7.5% coverage — the least-checked code in
 * the repository, and the code that spends a budget of four provider calls per
 * consent per day.
 *
 * `steps-handler.ts` is the only place that constructs the real ones.
 */
export interface StepDeps {
  readonly truelayer: TrueLayerClient;
  readonly connections: Connections;
  readonly s3: S3Client;
  readonly rawBucket: string;
  readonly tenantId: string;
  /**
   * "live" or "sandbox" — which TrueLayer environment the data came from,
   * recorded in the raw envelope so a replay knows what it is replaying.
   *
   * NOT the metric dimension. One field called `environment` used to serve both
   * meanings, and the metrics went out under "live" while every alarm in
   * `infra/lib/ingest-stack.ts` watched "dev". Three alarms could not fire, and
   * because they treat missing data as not breaching they looked healthy.
   */
  readonly providerEnvironment: string;
  /**
   * "dev" or "prod" — the deployment, and what the alarms dimension on.
   *
   * From ENVIRONMENT. Defaults to "dev" rather than being left unset, because
   * an undefined dimension matches no alarm at all.
   */
  readonly deploymentEnvironment: string;
  readonly alertTopicArn?: string | undefined;
  readonly sns?: SNSClient | undefined;
}

export function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

/**
 * The two environments, which are not the same thing and were once one field.
 *
 * Takes `env` as an argument so both sides of each fallback are testable.
 * Inline, they were only ever exercised on whichever side the running machine
 * happened to be on, and a coverage threshold raised locally then failed in CI.
 */
export function stepEnvironments(env: NodeJS.ProcessEnv): {
  providerEnvironment: string;
  deploymentEnvironment: string;
} {
  return {
    // Which TrueLayer environment the data came from, recorded in the raw
    // envelope so a replay knows what it is replaying.
    providerEnvironment: env["TL_ENV"] === "sandbox" ? "sandbox" : "live",
    // The deployment, and what every alarm dimensions on. Defaults rather than
    // being left unset: an undefined dimension matches no alarm at all.
    deploymentEnvironment: env["ENVIRONMENT"] ?? "dev",
  };
}

/**
 * Build the real dependencies from the environment.
 *
 * Called by the Lambda entry point, and by nothing a test runs. The TrueLayer
 * client needs a secret, so this is async.
 */
export async function realDeps(): Promise<StepDeps> {
  const sm = new SecretsManagerClient({});
  const raw = await sm.send(new GetSecretValueCommand({ SecretId: required("CLIENT_SECRET_ID") }));
  const creds = JSON.parse(raw.SecretString ?? "{}") as { clientId: string; clientSecret: string };
  const sandbox = process.env["TL_ENV"] === "sandbox";

  return {
    truelayer: new TrueLayerClient(creds, sandbox ? SANDBOX : LIVE),
    connections: new Connections(required("CONNECTION_SECRET_PREFIX"), sm),
    s3: new S3Client({}),
    rawBucket: required("RAW_BUCKET"),
    tenantId: required("TENANT_ID"),
    ...stepEnvironments(process.env),
    alertTopicArn: process.env["ALERT_TOPIC_ARN"],
    sns: process.env["ALERT_TOPIC_ARN"] ? new SNSClient({}) : undefined,
  };
}

// ------------------------------------------------------------------ listing

/**
 * Step 1: the connections to sync.
 *
 * Every connection for the household by default — that is the daily run. A
 * connect passes the one it just created, so adding a second card does not
 * spend the other connections' unattended-call budget (four per 24 hours for
 * each account, endpoint and consent) or give an unrelated failure a chance to
 * muddy the execution that
 * matters. With one connection this was free; with a household holding several
 * it is not.
 *
 * Takes the whole execution input rather than a named field so an execution
 * started with no input at all still works — Step Functions defaults that to
 * `{}`, whereas a missing JSONPath reference is an error.
 */
export async function listConnections(
  deps: StepDeps,
  args: { input?: { connectionId?: string } },
): Promise<{ connections: Connection[] }> {
  const all = await deps.connections.list(deps.tenantId);
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
  /**
   * The date range the items may be fetched over, decided here because this is
   * where the connection — its consent age and its last successful sync — is
   * known.
   */
  window: SyncWindow;
  /** Data calls this step spent. The limit is four per resource per 24 hours. */
  providerCalls: number;
  /** When this connection's run began, so the outcome can time it. */
  startedAt: string;
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
export async function refreshAndList(
  deps: StepDeps,
  input: { connection: Connection },
): Promise<RefreshOutput> {
  const startedAt = new Date().toISOString();
  const tl = deps.truelayer;
  const conns = deps.connections;
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
        window: syncWindow(connection),
        providerCalls: deps.truelayer.calls,
        startedAt,
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
      await land(deps, connection.tenantId, listDataset(resource), null, res.body);
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
    // Computed from the connection as it was BEFORE this run, so a failure
    // leaves the next window wide enough to cover what this one missed.
    window: syncWindow(connection),
    providerCalls: deps.truelayer.calls,
    startedAt,
  };
}

// -------------------------------------------------------------------- fetch

export interface FetchInput {
  tenantId: string;
  accessToken: string;
  resource: Resource;
  itemId: string;
  /** The range from refreshAndList. Absent falls back to the safe minimum. */
  from?: string;
  to?: string;
}

/**
 * Step 3: everything for one account or card.
 *
 * This is the unit the state machine retries. It throws on a genuine failure so
 * the retry policy applies; endpoints the provider does not offer are reported
 * as skipped, because retrying a 501 forever helps nobody.
 */
export async function fetchItem(
  deps: StepDeps,
  input: FetchInput,
): Promise<{ objects: number; skipped: string[]; transactions: number; providerCalls: number }> {
  const tl = deps.truelayer;
  const { tenantId, accessToken, resource, itemId } = input;
  const now = new Date();
  // Never widen a missing range into the full history: that is the request the
  // provider refuses outright once the exemption has lapsed.
  const fallback = syncWindow({ connectedAt: new Date(0).toISOString() }, now);
  const from = input.from ?? fallback.from;
  const to = input.to ?? fallback.to;

  let objects = 0;
  const skipped: string[] = [];

  // Transactions first: they are the point of the exercise.
  const txRes = await tl.get(
    accessToken,
    `/data/v1/${resource}/${itemId}/transactions?from=${from}&to=${to}`,
  );
  await land(deps, tenantId, transactionsDataset(resource), itemId, txRes.body, { from, to });
  objects += 1;
  // Counted here because this is the only place that sees the response. It is
  // the number anomaly detection watches: a current account that does thirty a
  // day going to zero is a signal, and nothing else in the run would show it.
  const transactions = ((txRes.body as { results?: unknown[] }).results ?? []).length;

  const detail = await tl.get(accessToken, `/data/v1/${resource}/${itemId}`);
  await land(deps, tenantId, itemDataset(resource), itemId, detail.body);
  objects += 1;

  for (const spec of PER_ITEM_ENDPOINTS) {
    if (!spec.resources.includes(resource)) continue;
    const dataset = spec.dataset(resource);
    try {
      const res = await tl.get(accessToken, `/data/v1/${resource}/${itemId}/${spec.suffix}`);
      await land(deps, tenantId, dataset, itemId, res.body);
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

  return { objects, skipped, transactions, providerCalls: deps.truelayer.calls };
}

// ------------------------------------------------------------------ outcome

export interface OutcomeInput {
  connection: Connection;
  consentExpired?: boolean;
  daysUntilConsentExpiry?: number;
  /** Calls spent by refreshAndList, which the results do not include. */
  refreshCalls?: number;
  /** From refreshAndList, so the run can be timed end to end. */
  startedAt?: string;
  results?: Array<{
    objects?: number;
    skipped?: string[];
    transactions?: number;
    providerCalls?: number;
    Error?: string;
    Cause?: string;
  }>;
}

const NUDGE_DAYS = 10;

/** One namespace for the whole application. */
export const METRIC_NAMESPACE = "Tightarse";

/**
 * Final step: record what happened and raise anything a human must act on.
 *
 * Runs whether or not items failed, so a partial sync still warns about an
 * expiring consent.
 *
 * lastSyncedAt advances ONLY when every item succeeded, because the next run's
 * window is measured from it. It used to move on any run that did not hit an
 * expired consent — so two days of every item failing with 403 still read as
 * "synced minutes ago", and a window computed from that would have sailed past
 * the missing data and never gone back for it. A gap that looks healthy is
 * worse than one that fails loudly.
 */
export async function recordOutcome(
  deps: StepDeps,
  input: OutcomeInput,
): Promise<{ problems: string[] }> {
  const { connection } = input;
  const problems: string[] = [];
  const results = input.results ?? [];

  const failed = results.filter((r) => r.Error);

  if (input.consentExpired) {
    problems.push(`Consent for ${connection.connectionId} has expired — reconnect at the bank.`);
  } else if (failed.length === 0) {
    await deps.connections.update({ ...connection, lastSyncedAt: new Date().toISOString() });
  }

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
  //
  // Emitted as metrics rather than a plain log line so the shape of a sync can
  // be watched over time. A connection returning nothing is not a failure — a
  // dormant account has nothing to return — so this is measured rather than
  // alarmed on directly, and anomaly detection decides what is unusual for
  // this household.
  const transactions = results.reduce((n, r) => n + (r.transactions ?? 0), 0);
  emit({
    namespace: METRIC_NAMESPACE,
    environment: deps.deploymentEnvironment,
    metrics: {
      TransactionsFetched: transactions,
      ObjectsLanded: results.reduce((n, r) => n + (r.objects ?? 0), 0),
      ItemsAttempted: results.length,
      ItemsFailed: failed.length,
      ItemsSkipped: results.reduce((n, r) => n + (r.skipped?.length ?? 0), 0),
      ConsentDaysRemaining: days,
      SyncProblems: problems.length,
      // The limit is four per 24 hours for each account, endpoint and consent,
      // so what matters is calls per RESOURCE, not the total: divide by
      // ItemsAttempted and anything far above one endpoint-set is retrying.
      ProviderCalls:
        (input.refreshCalls ?? 0) + results.reduce((n, r) => n + (r.providerCalls ?? 0), 0),
      SyncDurationMs: input.startedAt ? Date.now() - Date.parse(input.startedAt) : 0,
    },
    units: { SyncDurationMs: "Milliseconds" },
    properties: {
      // High cardinality, so a property: searchable, not billed, not alarmed.
      connectionId: connection.connectionId,
      consentExpired: input.consentExpired === true,
    },
  });

  if (problems.length > 0 && deps.alertTopicArn && deps.sns) {
    await deps.sns.send(
      new PublishCommand({
        TopicArn: deps.alertTopicArn,
        Subject: "Tightarse: attention needed",
        Message: problems.join("\n"),
      }),
    );
  }
  return { problems };
}

// -------------------------------------------------------------------- shared

async function land(
  deps: StepDeps,
  tenantId: string,
  dataset: string,
  accountId: string | null,
  body: unknown,
  params: Record<string, string> = {},
): Promise<void> {
  const fetchedAt = new Date().toISOString();
  const payload = JSON.stringify({
    captureVersion: 1,
    environment: deps.providerEnvironment,
    endpoint: dataset,
    params,
    accountId,
    fetchedAt,
    httpStatus: 200,
    body,
  });
  await deps.s3.send(
    new PutObjectCommand({
      Bucket: deps.rawBucket,
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
