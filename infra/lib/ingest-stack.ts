import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as events from "aws-cdk-lib/aws-events";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as destinations from "aws-cdk-lib/aws-lambda-destinations";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as kms from "aws-cdk-lib/aws-kms";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import * as path from "node:path";
import { config, connectRedirectUri, secretPrefix, type EnvSettings } from "./config";

export interface IngestStackProps extends cdk.StackProps {
  readonly settings: EnvSettings;
  readonly rawBucket: s3.Bucket;
  readonly table: dynamodb.TableV2;
  readonly dataKey: kms.IKey;
  readonly clientSecret: secretsmanager.ISecret;
  /** Where consent warnings and sync failures go. */
  /** Fixed so ApiStack can route to it by name without a construct reference. */
  readonly connectFunctionName: string;
}

/**
 * Everything that keeps the ledger current.
 *
 * Stateless: destroy and redeploy freely. The connections it uses live in
 * FoundationStack and the data it produces lives in the raw bucket, so nothing
 * here is irreplaceable.
 *
 * Three pieces:
 *   sync       daily, fetches from the provider and lands raw objects
 *   transform  fires on each new raw object and writes ledger rows
 *   connect    turns a bank authorisation into a stored connection
 */
export class IngestStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: IngestStackProps) {
    super(scope, id, props);

    const { settings, rawBucket, table, dataKey, clientSecret } = props;
    const connectionPrefix = `${secretPrefix(settings.name)}/connections`;

    /**
     * A topic, and deliberately no subscription.
     *
     * There was an email subscription here and it delivered nothing for its
     * entire existence. An SNS email subscription is inert until the recipient
     * clicks a confirmation link; that link was never clicked, SNS discarded the
     * pending subscription after three days, and CloudFormation went on
     * reporting the resource as CREATE_COMPLETE. So the stack, the template and
     * the tests all described alerting that did not exist — worse than having
     * none, because it stops anyone looking.
     *
     * The topic stays because it is a real seam: `steps.ts` publishes to it when
     * ALERT_TOPIC_ARN is set, and the anomaly alarm targets it directly. Alarm
     * state and history are recorded by CloudWatch whether or not anything is
     * subscribed, which is what is wanted for now.
     *
     * Adding delivery back is a subscription and a confirmed click. It should
     * not be described as working until a real alarm has reached a human.
     */
    const alerts = new sns.Topic(this, "Alerts", {
      displayName: `Tightarse ${settings.name}`,
    });

    /**
     * Creating a connection secret.
     *
     * Scoped with the `secretsmanager:Name` condition because there is no ARN
     * to name yet — which is precisely the case that condition key exists for.
     */
    const createConnectionSecret = new iam.PolicyStatement({
      actions: ["secretsmanager:CreateSecret", "secretsmanager:TagResource"],
      resources: ["*"],
      conditions: {
        StringLike: { "secretsmanager:Name": [`${connectionPrefix}/*`] },
      },
    });

    /**
     * Reading and updating an existing connection secret, scoped by ARN.
     *
     * `secretsmanager:Name` does NOT work here. It is only evaluated for
     * CreateSecret; on actions against an existing secret the key is absent, so
     * the condition never matches and every call is denied. That mistake let a
     * connection be written and then made it unreadable — the sync failed with
     * AccessDenied on a secret it had just created.
     *
     * The trailing wildcard covers the six random characters Secrets Manager
     * appends to every ARN.
     */
    const useConnectionSecret = new iam.PolicyStatement({
      actions: [
        "secretsmanager:GetSecretValue",
        "secretsmanager:PutSecretValue",
        "secretsmanager:UpdateSecret",
        "secretsmanager:DescribeSecret",
        "secretsmanager:DeleteSecret",
      ],
      resources: [
        cdk.Arn.format(
          {
            service: "secretsmanager",
            resource: "secret",
            resourceName: `${connectionPrefix}/*`,
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          },
          this,
        ),
      ],
    });

    /**
     * Listing, which cannot be resource-scoped at all.
     *
     * Exposes secret NAMES across the account, never values — the statements
     * above keep value access to the connection prefix, so the TrueLayer client
     * secret and the Google credentials stay unreadable here.
     */
    const listSecrets = new iam.PolicyStatement({
      actions: ["secretsmanager:ListSecrets"],
      resources: ["*"],
    });

    const common = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      bundling: { minify: true, sourceMap: true, target: "node22" },
    } as const;

    // ------------------------------------------------------------------ sync
    //
    // A state machine rather than one looping Lambda. The reason is retry, not
    // presentation: previously a transient failure on one account was recorded
    // and the run moved on, leaving that account stale until the next day's
    // schedule. Per-item steps retry in seconds instead.

    const steps = new NodejsFunction(this, "SyncSteps", {
      ...common,
      entry: path.join(__dirname, "../../services/ingest/src/steps-handler.ts"),
      handler: "handler",
      memorySize: 512,
      // A 9,000-transaction history takes ~14s on its own; this covers one
      // account or card, not a whole connection.
      timeout: cdk.Duration.minutes(2),
      environment: {
        TENANT_ID: "frost",
        RAW_BUCKET: rawBucket.bucketName,
        CONNECTION_SECRET_PREFIX: connectionPrefix,
        CLIENT_SECRET_ID: clientSecret.secretName,
        ALERT_TOPIC_ARN: alerts.topicArn,
        // Whether this deployment may refresh a connection. See the reasoning
        // on EnvSettings.syncEnabled — only one deployment may, ever.
        SYNC_ENABLED: String(settings.syncEnabled),
        // Dimensions this function's metrics. Without it the sync emitted under
        // the TrueLayer environment — "live" — while every alarm below watches
        // the deployment, so none of them could fire.
        ENVIRONMENT: settings.name,
      },
      logGroup: new logs.LogGroup(this, "SyncLogs", {
        retention: settings.name === "prod" ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    rawBucket.grantPut(steps);
    dataKey.grantEncryptDecrypt(steps);
    clientSecret.grantRead(steps);
    steps.addToRolePolicy(createConnectionSecret);
    steps.addToRolePolicy(useConnectionSecret);
    steps.addToRolePolicy(listSecrets);
    alerts.grantPublish(steps);

    const invoke = (id: string, step: string, payload: Record<string, unknown>) =>
      new tasks.LambdaInvoke(this, id, {
        lambdaFunction: steps,
        payload: sfn.TaskInput.fromObject({ step, ...payload }),
        outputPath: "$.Payload",
      });

    const fetchOne = invoke("FetchItem", "fetchItem", {
      "tenantId.$": "$.tenantId",
      "accessToken.$": "$.accessToken",
      "resource.$": "$.resource",
      "itemId.$": "$.itemId",
      "from.$": "$.from",
      "to.$": "$.to",
    });
    // The retry that justifies the whole structure. A 500 or a throttle on one
    // account no longer costs a day of freshness.
    fetchOne.addRetry({
      errors: ["States.TaskFailed", "States.Timeout"],
      interval: cdk.Duration.seconds(3),
      maxAttempts: 4,
      backoffRate: 2,
    });
    // One failing account must not sink the others, so the error is captured as
    // a result and reported by the outcome step.
    fetchOne.addCatch(new sfn.Pass(this, "ItemFailed"), { resultPath: "$" });

    const perConnection = invoke("RefreshAndList", "refreshAndList", {
      "connection.$": "$",
    })
      .next(
        new sfn.Choice(this, "ConsentValid?")
          .when(
            sfn.Condition.booleanEquals("$.consentExpired", true),
            invoke("ExpiredOutcome", "recordOutcome", {
              "connection.$": "$.connection",
              "consentExpired.$": "$.consentExpired",
              "daysUntilConsentExpiry.$": "$.daysUntilConsentExpiry",
            }),
          )
          .otherwise(
            new sfn.Map(this, "EachItem", {
              itemsPath: "$.items",
              maxConcurrency: 2,
              itemSelector: {
                "tenantId.$": "$.connection.tenantId",
                "accessToken.$": "$.accessToken",
                // Decided per connection: everything the bank will give inside
                // the SCA exemption window, and afterwards just enough to cover
                // the gap since the last successful sync — bounded at 88 days,
                // because a longer request is refused outright rather than
                // truncated.
                "from.$": "$.window.from",
                "to.$": "$.window.to",
                "resource.$": "$$.Map.Item.Value.resource",
                "itemId.$": "$$.Map.Item.Value.itemId",
              },
              resultPath: "$.results",
            })
              .itemProcessor(fetchOne)
              .next(
                invoke("Outcome", "recordOutcome", {
                  "connection.$": "$.connection",
                  "daysUntilConsentExpiry.$": "$.daysUntilConsentExpiry",
                  "results.$": "$.results",
                  // The listing step's own calls and start time: the per-item
                  // results cannot know either.
                  "refreshCalls.$": "$.providerCalls",
                  "startedAt.$": "$.startedAt",
                }),
              ),
          ),
      );

    const definition = invoke("ListConnections", "listConnections", {
      // The whole execution input: `{}` on the schedule, `{connectionId}` from
      // a connect. A named JSONPath would fail the run when the field is absent.
      "input.$": "$",
    }).next(
      new sfn.Map(this, "EachConnection", {
        itemsPath: "$.connections",
        maxConcurrency: 1,
      }).itemProcessor(perConnection),
    );

    const syncMachine = new sfn.StateMachine(this, "SyncMachine", {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      // Standard, not Express: 90 days of visible execution history and
      // redrive, which is the point. Express keeps no history worth reading.
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: cdk.Duration.minutes(30),
      tracingEnabled: true,
    });

    // Once a day. Unattended access is capped at four calls per 24 hours per
    // account, endpoint and consent, so daily spends one of four per resource
    // consent and a sync makes several per account, so hourly would breach it.
    new events.Rule(this, "DailySync", {
      schedule: events.Schedule.cron(config.ingestScheduleCron),
      targets: [new targets.SfnStateMachine(syncMachine)],
      description: "Daily TrueLayer sync",
    });

    // ------------------------------------------------------------- transform

    const transform = new NodejsFunction(this, "Transform", {
      ...common,
      entry: path.join(__dirname, "../../services/transform/src/transform-handler.ts"),
      handler: "handler",
      // 512 is a deliberate cap, not a quota we are waiting to escape.
      //
      // These accounts do sit at the default limit — an earlier note claimed it
      // had since been raised (#43) and it had not — but raising it is not the
      // plan. A Lambda that wants a large heap is usually one holding a whole
      // dataset in memory when it could stream or be split, so the cap is a
      // design constraint worth keeping rather than an obstacle.
      //
      // Ample here regardless: the largest raw object is about 6MB decompressed.
      // `infra/test/quotas.test.ts` asserts it across every stack, because a
      // deploy above it fails and rolls the stack back.
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      environment: {
        RAW_BUCKET: rawBucket.bucketName,
        TABLE_NAME: table.tableName,
        // Dimensions the metrics this function emits. Without it every metric
        // lands under "dev" and prod's alarms watch the wrong data.
        ENVIRONMENT: settings.name,
      },
      logGroup: new logs.LogGroup(this, "TransformLogs", {
        retention: settings.name === "prod" ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    rawBucket.grantRead(transform);
    dataKey.grantDecrypt(transform);
    table.grantReadWriteData(transform);

    /**
     * Where a raw object that could not be transformed goes.
     *
     * EventBridge retries a failed invocation and then drops it, silently. On the
     * daily path that is survivable — the next sync re-lands the object and the
     * transform runs again. It is not survivable on a one-time load, such as
     * copying the raw zone into a new account, because there is no next sync: a
     * dropped object is a permanently missing slice of the ledger that nothing
     * reports.
     *
     * A destination rather than DeadLetterConfig, because a destination carries
     * the error alongside the original event. The event alone tells you which
     * object failed; the error tells you why, which is the difference between a
     * lookup and an investigation.
     *
     * Fourteen days is SQS's maximum retention. The alarm below is what makes
     * that a backstop rather than the mechanism — a queue nobody watches is not
     * much better than no queue, which this repository has already proved once
     * with an SNS subscription that was never confirmed.
     */
    const transformFailures = new sqs.Queue(this, "TransformFailures", {
      queueName: `${config.appName}-${settings.name}-transform-failures`,
      retentionPeriod: cdk.Duration.days(14),
      // SQS-managed rather than the data key: the message is an S3 event and an
      // error string, so it carries an object key and no financial data. Using
      // the data key would mean granting Lambda kms:GenerateDataKey for no gain.
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy: settings.removalPolicy,
    });
    transform.configureAsyncInvoke({
      onFailure: new destinations.SqsDestination(transformFailures),
      // Two retries then the destination. The default is two; stated because the
      // number is the difference between a transient throttle being absorbed and
      // an object needing a human.
      retryAttempts: 2,
    });

    // One event per object, so a failure isolates to a single response and a
    // replay can target one dataset.
    //
    // Matched by bucket NAME rather than by construct: referencing the bucket
    // object would make this stack depend on DataStack while DataStack's
    // notification depended on this function, which is a cycle CDK refuses.
    new events.Rule(this, "RawObjectCreated", {
      description: "Transform each raw object as it lands",
      eventPattern: {
        source: ["aws.s3"],
        detailType: ["Object Created"],
        detail: {
          bucket: { name: [rawBucket.bucketName] },
          object: { key: [{ prefix: "tenant=" }] },
        },
      },
      targets: [new targets.LambdaFunction(transform)],
    });

    // ---------------------------------------------------------- categorise

    // Categorisation was a command somebody typed, which made coverage a
    // high-water mark rather than a floor: the sync lands new transactions
    // every morning and nothing categorised them, so the share of the ledger
    // with a category fell a little each day.
    //
    // Rules only. The model path costs money per run and belongs to an
    // operator choosing to spend it, not to a schedule that spends it at 06:00
    // whether or not anyone is looking.
    const categorise = new NodejsFunction(this, "Categorise", {
      ...common,
      entry: path.join(__dirname, "../../agents/categoriser/src/handler.ts"),
      handler: "handler",
      memorySize: 512,
      // The backlog is derived by diffing transactions against enrichments, so
      // the work is proportional to the window, not to the ledger.
      timeout: cdk.Duration.minutes(5),
      environment: {
        TABLE_NAME: table.tableName,
        TENANT_ID: "frost",
        BACKFILL_DAYS: "45",
        ENVIRONMENT: settings.name,
      },
      logGroup: new logs.LogGroup(this, "CategoriseLogs", {
        retention: settings.name === "prod" ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    table.grantReadWriteData(categorise);
    dataKey.grantEncryptDecrypt(categorise);

    // An hour after the sync, so it categorises what that run landed rather
    // than racing it.
    new events.Rule(this, "DailyCategorise", {
      description: "Categorise newly landed transactions with rules",
      schedule: events.Schedule.cron({ minute: "0", hour: "6" }),
      targets: [new targets.LambdaFunction(categorise)],
    });

    // Reconciliation, after the categoriser so it sees a settled ledger.
    //
    // Its own function rather than part of the transform: the transform runs
    // once per raw object with no ordering between them, so a balance reading
    // and the transactions it should be checked against arrive as separate
    // events. Checking at write time would compare against whatever had landed.
    const reconcile = new NodejsFunction(this, "Reconcile", {
      ...common,
      entry: path.join(__dirname, "../../services/transform/src/reconcile-handler.ts"),
      handler: "handler",
      memorySize: 512,
      // Scans the table and groups in memory. Small at this size, and a single
      // consistent read beats reconciling one account's balances against
      // another's transactions.
      timeout: cdk.Duration.minutes(5),
      environment: {
        TABLE_NAME: table.tableName,
        TENANT_ID: "frost",
        ENVIRONMENT: settings.name,
      },
      logGroup: new logs.LogGroup(this, "ReconcileLogs", {
        retention: settings.name === "prod" ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    table.grantReadWriteData(reconcile);
    dataKey.grantEncryptDecrypt(reconcile);

    new events.Rule(this, "DailyReconcile", {
      description: "Check the ledger's transactions against the balances the bank reported",
      schedule: events.Schedule.cron({ minute: "0", hour: "7" }),
      targets: [new targets.LambdaFunction(reconcile)],
    });

    // ----------------------------------------------------------- monitoring

    // The sync spent two days fetching nothing while every execution reported
    // SUCCEEDED: balances kept updating, so nothing looked wrong. Metrics come
    // from the Lambdas in embedded metric format; these are the alarms.
    const metric = (metricName: string, statistic = "Sum") =>
      new cloudwatch.Metric({
        namespace: "Tightarse",
        metricName,
        dimensionsMap: { Environment: settings.name },
        statistic,
        period: cdk.Duration.hours(24),
      });

    const alarmAction = new cwActions.SnsAction(alerts);

    // An item failing is unambiguous, so it is a threshold rather than a
    // pattern. Four items failed every day and only an execution's output said
    // so, which nobody reads.
    /**
     * A raw object the transform could not turn into ledger rows.
     *
     * The raw zone is intact — the object is still there and the transform is
     * idempotent, so this is always recoverable by replaying it. What is not
     * recoverable is not knowing: the ledger is short by whatever that object
     * held, every balance derived after it is wrong, and the numbers stay
     * plausible.
     *
     * One message is worth waking up for, so the threshold is zero rather than a
     * rate. Anything above zero means a slice of the ledger is missing right now.
     */
    const transformFailed = new cloudwatch.Alarm(this, "TransformFailuresAlarm", {
      alarmName: `tightarse-${settings.name}-transform-failures`,
      alarmDescription:
        "A raw object could not be transformed and has been parked. The raw zone still " +
        "holds it and the transform is idempotent, so replay it once the cause is fixed.",
      metric: transformFailures.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: "Maximum",
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      // An empty queue emits zero rather than nothing, so missing data here means
      // the metric is not reporting at all, which is not a breach.
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    transformFailed.addAlarmAction(alarmAction);

    const itemsFailed = new cloudwatch.Alarm(this, "SyncItemsFailed", {
      alarmName: `tightarse-${settings.name}-sync-items-failed`,
      alarmDescription: "One or more accounts could not be fetched in a sync run.",
      metric: metric("ItemsFailed"),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    itemsFailed.addAlarmAction(alarmAction);

    // A settled ACCOUNT transaction with no running balance is a gap in the
    // balance series, and the series is the point — a balance endpoint returns
    // a snapshot and cannot say how the position moved.
    //
    // Accounts only, deliberately. Measured against the live ledger: 9,498 of
    // 9,498 settled account transactions carry a running balance, and 0 of 278
    // card transactions do. TrueLayer marks the field optional on both
    // endpoints and documents no rule, so this was a matter of observation
    // rather than reading — and the answer is that cards never supply one.
    //
    // So a card alarm at a threshold of zero would fire on every sync for ever.
    // An alarm that always fires is worse than no alarm: it trains everyone to
    // ignore the one that matters, which is the mistake the anomaly detector
    // below exists to avoid. The card metric is still emitted, so if Amex ever
    // starts supplying running balances it will show up in the graph — but it
    // is not something to be woken by.
    //
    // Threshold of zero for accounts, following SyncItemsFailed: unambiguous
    // rather than a pattern to be learned. We believe it will never fire, and
    // that belief is what is being tested. See #30 — the response is to
    // observe, never to reconstruct.
    const unanchored = new cloudwatch.Alarm(this, "UnanchoredAccountTransactions", {
      alarmName: `tightarse-${settings.name}-unanchored-account-transactions`,
      alarmDescription:
        "A settled account transaction arrived with no running balance, so the balance " +
        "series has a gap. See #30 — do not reconstruct.",
      metric: metric("UnanchoredAccountTransactions"),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      // Nothing emitted means no settled transactions were transformed, which
      // is normal on a quiet day and must not read as a breach.
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    unanchored.addAlarmAction(alarmAction);

    // The provider's data being far older than the request that fetched it.
    //
    // Measured before this threshold was chosen: accounts fresh in all 22 real
    // readings, cards stale in 8 of 23 with a worst case of 32 minutes. So
    // caching of tens of minutes is normal and must not alarm.
    //
    // A day is well beyond anything observed, and it is the point at which the
    // reading would land on the wrong day and take a whole day's transactions
    // to the wrong side of a reconciliation window. It also catches the real
    // risk: the card balance endpoint documents `update_timestamp` not at all,
    // so if some provider uses it for a statement date instead, this fires
    // rather than the ledger quietly reconciling against the wrong day.
    const stale = new cloudwatch.Alarm(this, "BalanceStale", {
      alarmName: `tightarse-${settings.name}-balance-stale`,
      alarmDescription:
        "A balance arrived describing a moment more than a day before we asked. Normal " +
        "caching is tens of minutes; a day suggests update_timestamp does not mean what " +
        "we take it to mean. See #33.",
      metric: metric("BalanceStalenessSeconds", "Maximum"),
      threshold: 86_400,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    stale.addAlarmAction(alarmAction);

    // The bank's arithmetic against ours:
    //
    //   balance(newest reading) - balance(oldest) == sum of amounts between
    //
    // A break means a transaction is missing, or one is present that should not
    // be. Either way every balance derived from that series is wrong, and until
    // this existed nothing detected it — the numbers simply stayed plausible,
    // which is the worst kind of wrong for money.
    //
    // Both an account and a card alarm, unlike the unanchored pair above, and
    // the difference is the point: this check needs no running balance, so it
    // covers cards, which carry none. It was run against five years of real
    // data before being given a threshold — 5 accounts, 5 checks, 0 breaks — so
    // it is not expected to fire, which is what a threshold of zero requires.
    for (const [id, metricName, what] of [
      ["ReconciliationBreaksAccount", "ReconciliationBreaksAccount", "account"],
      ["ReconciliationBreaksCard", "ReconciliationBreaksCard", "card"],
    ] as const) {
      const alarm = new cloudwatch.Alarm(this, id, {
        alarmName: `tightarse-${settings.name}-reconciliation-${what}`,
        alarmDescription:
          `An ${what}'s transactions do not account for the change in its balance. ` +
          `A transaction is missing, or one is present that should not be. See #33.`,
        metric: metric(metricName),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        // Nothing emitted means the phase did not run, which is its own problem
        // and not a break.
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(alarmAction);
    }

    // Reconfirmation needs a person at a browser, so the warning has to arrive
    // with time to act rather than on the day access stops.
    const consentExpiring = new cloudwatch.Alarm(this, "ConsentExpiring", {
      alarmName: `tightarse-${settings.name}-consent-expiring`,
      alarmDescription: "A bank consent lapses soon and needs reconfirming in a browser.",
      metric: metric("ConsentDaysRemaining", "Minimum"),
      threshold: 10,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.MISSING,
    });
    consentExpiring.addAlarmAction(alarmAction);

    // Transactions fetched is the one that cannot be a threshold. Zero is
    // normal for a dormant account and alarming on it would page for nothing,
    // which trains everyone to ignore the alarm that matters. Anomaly detection
    // learns what is normal for this household instead.
    //
    // It needs history before it means anything — expect INSUFFICIENT_DATA for
    // the first couple of weeks rather than a working alarm.
    const detectorMetric = {
      metricName: "TransactionsFetched",
      namespace: "Tightarse",
      dimensions: [{ name: "Environment", value: settings.name }],
      stat: "Sum",
    };
    new cloudwatch.CfnAnomalyDetector(this, "TransactionsFetchedDetector", {
      singleMetricAnomalyDetector: detectorMetric,
    });

    // CfnAlarm rather than the L2: only the low-level construct exposes
    // ThresholdMetricId, which is what makes an alarm anomaly-based.
    new cloudwatch.CfnAlarm(this, "TransactionsFetchedAnomaly", {
      alarmName: `tightarse-${settings.name}-transactions-anomalous`,
      alarmDescription:
        "Transactions fetched is outside the band learned for this household — either a feed has stopped, or something changed.",
      comparisonOperator: "LessThanLowerOrGreaterThanUpperThreshold",
      evaluationPeriods: 1,
      thresholdMetricId: "band",
      treatMissingData: "missing",
      alarmActions: [alerts.topicArn],
      metrics: [
        {
          id: "fetched",
          returnData: true,
          metricStat: {
            metric: detectorMetric,
            period: cdk.Duration.hours(24).toSeconds(),
            stat: "Sum",
          },
        },
        {
          id: "band",
          // Two standard deviations: wide enough that an ordinary quiet
          // weekend does not page, narrow enough to catch a feed stopping.
          expression: "ANOMALY_DETECTION_BAND(fetched, 2)",
          returnData: true,
        },
      ],
    });

    // --------------------------------------------------------------- connect

    const connect = new NodejsFunction(this, "Connect", {
      ...common,
      functionName: props.connectFunctionName,
      entry: path.join(__dirname, "../../services/ingest/src/connect.ts"),
      handler: "handler",
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        CONNECTION_SECRET_PREFIX: connectionPrefix,
        CLIENT_SECRET_ID: clientSecret.secretName,
        // Derived from the site URL, and registered with TrueLayer by hand —
        // the provider matches this exactly and nothing in CDK can register it.
        CONNECT_REDIRECT_URI: connectRedirectUri(settings),
        SYNC_STATE_MACHINE_ARN: syncMachine.stateMachineArn,
      },
      logGroup: new logs.LogGroup(this, "ConnectLogs", {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    clientSecret.grantRead(connect);
    connect.addToRolePolicy(createConnectionSecret);
    connect.addToRolePolicy(useConnectionSecret);
    // Started, not awaited. The deep-history window is open at this moment and
    // shuts within the hour, so waiting for the daily schedule would silently
    // reduce a new connection to 90 days of history. Starting the machine
    // returns to the browser immediately while the fetch runs with retries.
    syncMachine.grantStartExecution(connect);

    new cdk.CfnOutput(this, "AlertTopicArn", { value: alerts.topicArn });
    new cdk.CfnOutput(this, "SyncMachineArn", { value: syncMachine.stateMachineArn });
    new cdk.CfnOutput(this, "ConnectFunctionArn", { value: connect.functionArn });

    cdk.Tags.of(this).add("app", config.appName);
    cdk.Tags.of(this).add("env", settings.name);
    cdk.Tags.of(this).add("tier", "stateless");
  }
}
