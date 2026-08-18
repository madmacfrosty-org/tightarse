import { DynamoStore } from "@tightarse/dynamodb";
import { S3RawObjects } from "@tightarse/aws";
import { emit } from "@tightarse/metrics";
import { transformObject, type TransformResult } from "@tightarse/transform";

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

export interface ObjectCreated {
  detail: { object: { key: string } };
}

/**
 * Everything this handler reaches outside itself.
 *
 * `transform` is a function rather than the clients behind it, because what
 * matters at this seam is what gets reported about the result rather than how
 * the object was read.
 */
export interface TransformHandlerDeps {
  readonly transform: (key: string) => Promise<TransformResult>;
  /** Dimensions the metrics: the deployment, "dev" or "prod". */
  readonly environment: string;
  readonly log?: ((line: string) => void) | undefined;
}

/**
 * Built by the entry point below, and by nothing a test runs.
 *
 * ENVIRONMENT is the deployment, which is what the alarms in
 * `infra/lib/ingest-stack.ts` dimension on. Deliberately not the TrueLayer
 * environment — a metric emitted under "live" is invisible to an alarm watching
 * "dev".
 */
export interface HandlerConfig {
  readonly bucket: string;
  readonly tableName: string;
  readonly region: string;
  readonly environment: string;
}

/**
 * Everything read from the environment, in one place that takes `env` as an
 * argument.
 *
 * Separate so both sides of each fallback are testable. Inline, they were only
 * ever exercised on whichever side the running machine happened to be on —
 * AWS_REGION is set in CI and unset on a laptop — so branch coverage differed
 * between the two and a threshold raised locally failed the build in CI.
 */
export function handlerConfig(env: NodeJS.ProcessEnv): HandlerConfig {
  return {
    bucket: env["RAW_BUCKET"] ?? "",
    tableName: env["TABLE_NAME"] ?? "",
    region: env["AWS_REGION"] ?? "eu-west-1",
    environment: env["ENVIRONMENT"] ?? "dev",
  };
}

export function realDeps(): TransformHandlerDeps {
  const config = handlerConfig(process.env);
  const raw = new S3RawObjects({ bucket: config.bucket, region: config.region });
  const ledger = new DynamoStore({ tableName: config.tableName, region: config.region });
  return {
    transform: (key: string) => transformObject({ raw, ledger, bucket: config.bucket }, key),
    environment: config.environment,
  };
}

/**
 * EventBridge delivers the key URL-encoded, and ours contain '=' and can
 * contain characters that only survive a round trip once decoded.
 */
export function keyFromEvent(event: ObjectCreated): string {
  return decodeURIComponent(event.detail.object.key.replace(/\+/g, " "));
}

export async function processObject(
  deps: TransformHandlerDeps,
  event: ObjectCreated,
): Promise<TransformResult> {
  const result = await deps.transform(keyFromEvent(event));
  const write = deps.log ?? console.log;

  // Counts only — a transaction body must never reach CloudWatch. A description
  // is a merchant, a person's name, or an employer.
  write(JSON.stringify({ dataset: result.dataset, handler: result.handler, rows: result.rows }));

  // Reported here rather than inside transformObject, so the transform stays a
  // function that returns what happened and the entry point does the telling.
  //
  // Only for settled transactions: `unanchored` is absent for every other kind
  // of object, and emitting a zero for those would drown the signal in objects
  // that could never have carried a running balance.
  // How far behind our request the provider's data was. Zero for accounts in
  // all 22 real readings measured; up to 32 minutes for cards in 8 of 23.
  //
  // Watched rather than assumed, because the card balance endpoint documents
  // `update_timestamp` not at all — the OpenAPI definition gives it a datatype
  // and no meaning. If some provider uses it for something else, such as a
  // statement date, this is what says so before a reading lands on the wrong
  // day and takes a whole day's transactions with it.
  if (result.staleness !== undefined) {
    emit(
      {
        namespace: "Tightarse",
        environment: deps.environment,
        metrics: { BalanceStalenessSeconds: result.staleness },
        units: { BalanceStalenessSeconds: "Seconds" },
        properties: { dataset: result.dataset },
      },
      write,
    );
  }

  if (result.unanchored) {
    emit(
      {
        namespace: "Tightarse",
        environment: deps.environment,
        metrics: {
          UnanchoredCardTransactions: result.unanchored.card,
          UnanchoredAccountTransactions: result.unanchored.account,
        },
        properties: { dataset: result.dataset },
      },
      write,
    );
  }

  return result;
}

/**
 * Lambda entry point, and the only place a client is constructed.
 *
 * Memoised, because these were built at module scope and a warm container
 * reused them.
 */
let cached: TransformHandlerDeps | undefined;

export async function handler(event: ObjectCreated): Promise<void> {
  cached ??= realDeps();
  await processObject(cached, event);
}
