import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";
import { config, type EnvSettings } from "./config";

export interface DataStackProps extends cdk.StackProps {
  readonly settings: EnvSettings;
}

/**
 * Everything stateful, in one stack.
 *
 * The test for inclusion is "if this vanished, could it be recreated from the
 * repo?" — and for all of these the answer is no. The ledger and raw objects
 * hold data; the user pool holds accounts whose passwords cannot be recovered.
 *
 * In dev this stack IS destroyable, deliberately — wiping it is how a bad
 * schema decision gets undone. What must survive that wipe lives in
 * FoundationStack: notably the TrueLayer refresh tokens, because redoing a
 * schema decision should not cost a trip through a bank's auth journey.
 *
 * Everything else — ingest, transform, API, web, agents — is stateless and
 * lives in stacks that can be destroyed and redeployed without consequence.
 */
export class DataStack extends cdk.Stack {
  public readonly table: dynamodb.TableV2;
  public readonly rawBucket: s3.Bucket;
  public readonly userPool: cognito.UserPool;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { settings } = props;

    // ---------------------------------------------------------------- ledger

    this.table = new dynamodb.TableV2(this, "Ledger", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      encryption: dynamodb.TableEncryptionV2.awsManagedKey(),
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: settings.pointInTimeRecovery,
      },
      removalPolicy: settings.removalPolicy,
      deletionProtection: settings.deletionProtection,
      // Settled writes trigger the categoriser. Old images let a consumer tell
      // a genuine change from a replayed no-op, and filter out enrichment
      // writes so the agent does not trigger itself.
      dynamoStream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      // Transactions expire nothing; this is for the transient pending cache,
      // which is delete-and-replaced each sync with a TTL as backstop.
      timeToLiveAttribute: "expiresAt",
      globalSecondaryIndexes: [
        {
          // Per-account views over time. The base table partitions by month
          // because the dashboard's dominant read is tenant-wide by month.
          indexName: "gsi1-account",
          partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
          sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.ALL,
        },
        {
          // Sparse: the attribute is written when a transaction lands and
          // REMOVED when enrichment is stored, so this index is exactly the
          // categoriser's backlog and nothing else.
          indexName: "gsi2-to-enrich",
          partitionKey: { name: "gsi2pk", type: dynamodb.AttributeType.STRING },
          sortKey: { name: "gsi2sk", type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.KEYS_ONLY,
        },
      ],
    });

    // ------------------------------------------------------ raw landing zone

    this.rawBucket = new s3.Bucket(this, "RawLandingZone", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // Provider responses are the copy that makes a buggy transform
      // survivable. Versioning guards against a bad overwrite too.
      versioned: true,
      removalPolicy: settings.removalPolicy,
      autoDeleteObjects: settings.autoDeleteObjects,
      lifecycleRules: [
        {
          id: "raw-retention",
          enabled: true,
          // Read rarely after the transform has run — but only worth moving to
          // IA if the object will outlive IA's 30-day minimum billing period.
          ...(settings.rawTransitionToIaDays !== undefined
            ? {
                transitions: [
                  {
                    storageClass: s3.StorageClass.INFREQUENT_ACCESS,
                    transitionAfter: cdk.Duration.days(settings.rawTransitionToIaDays),
                  },
                ],
              }
            : {}),
          expiration: cdk.Duration.days(settings.rawRetentionDays),
          noncurrentVersionExpiration: cdk.Duration.days(30),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });

    // -------------------------------------------------------------- identity

    this.userPool = new cognito.UserPool(this, "Users", {
      selfSignUpEnabled: false, // family only — accounts are created by hand
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: settings.removalPolicy,
      deletionProtection: settings.deletionProtection,
    });

    // ---------------------------------------------------------------- outputs

    new cdk.CfnOutput(this, "LedgerTableName", { value: this.table.tableName });
    new cdk.CfnOutput(this, "RawBucketName", { value: this.rawBucket.bucketName });
    new cdk.CfnOutput(this, "UserPoolId", { value: this.userPool.userPoolId });

    cdk.Tags.of(this).add("app", config.appName);
    cdk.Tags.of(this).add("env", settings.name);
    cdk.Tags.of(this).add("tier", "data");
  }
}
