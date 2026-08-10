import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as events from "aws-cdk-lib/aws-events";
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

    const connectionSecrets = new iam.PolicyStatement({
      actions: [
        "secretsmanager:CreateSecret",
        "secretsmanager:GetSecretValue",
        "secretsmanager:PutSecretValue",
        "secretsmanager:DescribeSecret",
        "secretsmanager:TagResource",
        "secretsmanager:ListSecrets",
      ],
      resources: ["*"],
      // ListSecrets cannot be resource-scoped, so the write actions are
      // constrained by name instead — a wildcard here would let this function
      // read the TrueLayer client secret and every other secret in the account.
      conditions: {
        StringLike: { "secretsmanager:Name": [`${connectionPrefix}/*`] },
      },
    });

    const common = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      bundling: { minify: true, sourceMap: true, target: "node22" },
    } as const;

    // ------------------------------------------------------------------ sync

    const sync = new NodejsFunction(this, "Sync", {
      ...common,
      entry: path.join(__dirname, "../../services/ingest/src/scheduled.ts"),
      handler: "handler",
      memorySize: 512,
      // A 9,000-transaction account takes ~14s for its history alone, and a
      // sync walks several endpoints across every account and card.
      timeout: cdk.Duration.minutes(5),
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
    rawBucket.grantPut(sync);
    dataKey.grantEncryptDecrypt(sync);
    clientSecret.grantRead(sync);
    sync.addToRolePolicy(connectionSecrets);
    alerts.grantPublish(sync);

    // Once a day. Unattended access is capped at four calls per 24 hours per
    // consent and a sync makes several per account, so hourly would breach it.
    new events.Rule(this, "DailySync", {
      schedule: events.Schedule.cron(config.ingestScheduleCron),
      targets: [new targets.LambdaFunction(sync)],
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

    // --------------------------------------------------------------- connect

    const connect = new NodejsFunction(this, "Connect", {
      ...common,
      entry: path.join(__dirname, "../../services/ingest/src/connect.ts"),
      handler: "handler",
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        CONNECTION_SECRET_PREFIX: connectionPrefix,
        CLIENT_SECRET_ID: clientSecret.secretName,
        CONNECT_REDIRECT_URI: this.node.tryGetContext("connectRedirectUri") ?? "http://localhost:5173/connected",
      },
      logGroup: new logs.LogGroup(this, "ConnectLogs", {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    clientSecret.grantRead(connect);
    connect.addToRolePolicy(connectionSecrets);

    new cdk.CfnOutput(this, "AlertTopicArn", { value: alerts.topicArn });
    new cdk.CfnOutput(this, "SyncFunctionName", { value: sync.functionName });
    new cdk.CfnOutput(this, "ConnectFunctionArn", { value: connect.functionArn });

    cdk.Tags.of(this).add("app", config.appName);
    cdk.Tags.of(this).add("env", settings.name);
    cdk.Tags.of(this).add("tier", "stateless");
  }
}
