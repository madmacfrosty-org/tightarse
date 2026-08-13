import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as events from "aws-cdk-lib/aws-events";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as kms from "aws-cdk-lib/aws-kms";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import * as path from "node:path";
import { config, secretPrefix, type EnvSettings } from "./config";

export interface IngestStackProps extends cdk.StackProps {
  readonly settings: EnvSettings;
  readonly rawBucket: s3.Bucket;
  readonly table: dynamodb.TableV2;
  readonly dataKey: kms.IKey;
  readonly clientSecret: secretsmanager.ISecret;
  /** Where consent warnings and sync failures go. */
  readonly alertEmail?: string;
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

    const alerts = new sns.Topic(this, "Alerts", {
      displayName: `Tightarse ${settings.name}`,
    });
    if (props.alertEmail) {
      alerts.addSubscription(new subs.EmailSubscription(props.alertEmail));
    }

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
    // consent and a sync makes several per account, so hourly would breach it.
    new events.Rule(this, "DailySync", {
      schedule: events.Schedule.cron(config.ingestScheduleCron),
      targets: [new targets.SfnStateMachine(syncMachine)],
      description: "Daily TrueLayer sync",
    });

    // ------------------------------------------------------------- transform

    const transform = new NodejsFunction(this, "Transform", {
      ...common,
      entry: path.join(__dirname, "../../services/ingest/src/transform-handler.ts"),
      handler: "handler",
      // 512 is the ceiling on a new AWS account until its Lambda quota is
      // raised. Ample here: the largest raw object is about 6MB decompressed.
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      environment: {
        RAW_BUCKET: rawBucket.bucketName,
        TABLE_NAME: table.tableName,
      },
      logGroup: new logs.LogGroup(this, "TransformLogs", {
        retention: settings.name === "prod" ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    rawBucket.grantRead(transform);
    dataKey.grantDecrypt(transform);
    table.grantReadWriteData(transform);

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
        CONNECT_REDIRECT_URI: this.node.tryGetContext("connectRedirectUri") ?? "http://localhost:5173/connected",
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
