import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as path from "node:path";
import { Construct } from "constructs";
import { config, type EnvSettings } from "./config";

export interface DataStackProps extends cdk.StackProps {
  readonly settings: EnvSettings;
  /** Customer-managed key from FoundationStack, so it survives a dev wipe. */
  readonly dataKey: kms.IKey;
  /** Google OAuth client secret, for federated sign-in. */
  readonly googleOAuthSecret: secretsmanager.ISecret;
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
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { settings } = props;

    // ---------------------------------------------------------------- ledger

    this.table = new dynamodb.TableV2(this, "Ledger", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      // The same customer-managed key as the raw bucket, not the AWS-managed
      // default. The bucket was given one because it holds real transactions;
      // this table holds the same transactions, so the requirement applies
      // equally. It was the default here purely because nobody said otherwise.
      //
      // Changing this on an existing table is done in place by DynamoDB — no
      // migration, no downtime — which is why it is worth correcting before
      // there is a prod table rather than after.
      encryption: dynamodb.TableEncryptionV2.customerManagedKey(props.dataKey),
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
          // Per-account views over time. The base table partitions by tenant
          // because the dashboard's dominant read is tenant-wide over a range.
          //
          // There is no "awaiting categorisation" index. That was a sparse GSI
          // keyed off a marker on the transaction row, but a plain put replaces
          // the whole row, so replaying a raw object re-queued already-
          // categorised work — and replay is the entire point of the landing
          // zone. The backlog is derived from a range query instead.
          indexName: "gsi1-account",
          partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
          sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.ALL,
        },
      ],
    });

    // ------------------------------------------------------ raw landing zone

    this.rawBucket = new s3.Bucket(this, "RawLandingZone", {
      // Customer-managed, not S3-managed: with SSE-S3 decryption is transparent
      // to anyone holding s3:GetObject, which would render the read-only role's
      // `Deny kms:Decrypt` useless against actual bank data.
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.dataKey,
      // Without this, every object read and write is a separate KMS API call.
      // Bucket keys cut that by roughly 99%.
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // Events go to EventBridge rather than a direct Lambda notification.
      // A notification would need the consuming function's ARN, and that
      // function lives in a stack which needs this bucket — a dependency cycle.
      // EventBridge rules match the bucket by name, so the reference is a
      // string and the cycle disappears. It also allows richer key matching
      // than notifications, whose filters are literal prefix and suffix only.
      eventBridgeEnabled: true,
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
      /**
       * Email SHOULD be mutable, and cannot be made so on this pool.
       *
       * Cognito re-applies an identity provider's attribute mapping on every
       * federated sign-in, not only at creation. With `mutable: false` the
       * first Google sign-in succeeds, creating the user, and every one after
       * it fails with `user.email: Attribute cannot be updated`. That is the
       * live symptom today.
       *
       * The obvious fix does not work. Setting `mutable: true` here produces a
       * plain property update, which Cognito rejects outright:
       *
       *   Invalid AttributeDataType input, consider using the provided
       *   AttributeDataType enum
       *
       * — its unhelpful way of saying a pool's schema cannot be modified after
       * creation. Tried on 16 August: the update failed, the stack went to
       * UPDATE_ROLLBACK_FAILED, and recovering it needed
       * `continue-update-rollback --resources-to-skip`. The pool itself was
       * untouched, so nothing was lost, but the stack was unable to deploy
       * until rescued.
       *
       * Fixing it properly means creating a NEW pool and retiring this one,
       * which is deliberate work rather than a property change — see #36.
       * Household access survives that, because it lives in a MEMBER row in the
       * ledger rather than in the pool.
       */
      standardAttributes: { email: { required: true, mutable: false } },
      /**
       * Which household this identity may read.
       *
       * The API takes the tenant from this claim and never from the request. A
       * query parameter would let any authenticated user read any household's
       * ledger, so this attribute is the entire access-control model.
       *
       * Immutable: a user changing their own household would be a privilege
       * escalation, and Cognito lets an attribute be self-mutable by default.
       */
      customAttributes: {
        tenant: new cognito.StringAttribute({ minLen: 1, maxLen: 64, mutable: false }),
      },
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

    /**
     * Injects the household claim at token-issue time.
     *
     * Federated sign-in has no attribute we control — Google's token says who
     * someone is, not which household they may read — and Cognito creates the
     * pool user automatically, so custom:tenant is never set. This reads an
     * administrator-created membership record and adds it.
     *
     * Fails closed: no membership, no claim, and the API refuses a token
     * without one.
     */
    const preToken = new NodejsFunction(this, "PreTokenGeneration", {
      entry: path.join(__dirname, "../../services/auth/src/pre-token.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(5),
      environment: { TABLE_NAME: this.table.tableName },
      bundling: { minify: true, sourceMap: true, target: "node22" },
    });
    this.table.grantReadData(preToken);
    this.userPool.addTrigger(cognito.UserPoolOperation.PRE_TOKEN_GENERATION, preToken);

    // Hosted UI domain. Federation requires the OAuth redirect flow; SRP cannot
    // do it, so this is what a "Sign in with Google" button actually talks to.
    this.userPool.addDomain("Domain", {
      cognitoDomain: { domainPrefix: settings.hostedUiPrefix },
    });

    // Only created once a Google client exists. Deploying an identity provider
    // with an empty secret fails, and gating it keeps the stack deployable
    // before the Google Cloud project is set up.
    const googleClientId = settings.googleClientId;
    let googleProvider: cognito.UserPoolIdentityProviderGoogle | undefined;
    if (googleClientId) {
      googleProvider = new cognito.UserPoolIdentityProviderGoogle(this, "Google", {
        userPool: this.userPool,
        clientId: googleClientId,
        clientSecretValue: props.googleOAuthSecret.secretValueFromJson("clientSecret"),
        scopes: ["openid", "email", "profile"],
        // Google's verified email becomes the pool user's email, which is what
        // the membership lookup keys on.
        //
        // email_verified must be mapped explicitly. Cognito defaults it to
        // FALSE for a federated user when it is not mapped, and the pre-token
        // trigger refuses to issue a household claim for an unverified address
        // — so omitting it silently locked out every Google sign-in while
        // looking like a membership problem.
        attributeMapping: {
          email: cognito.ProviderAttribute.GOOGLE_EMAIL,
          fullname: cognito.ProviderAttribute.GOOGLE_NAME,
          custom: {
            email_verified: cognito.ProviderAttribute.other("email_verified"),
          },
        },
      });
      this.userPool.registerIdentityProvider(googleProvider);
    }

    const callbackUrls = [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      ...(this.node.tryGetContext("siteUrl") ? [String(this.node.tryGetContext("siteUrl"))] : []),
    ];

    this.userPoolClient = this.userPool.addClient("WebClient", {
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls,
        logoutUrls: callbackUrls,
      },
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
        ...(googleClientId ? [cognito.UserPoolClientIdentityProvider.GOOGLE] : []),
      ],
      // No client secret: this is a browser app and cannot keep one, and the
      // authorisation-code flow with PKCE does not need one.
      generateSecret: false,
      // Password sign-in stays enabled alongside Google. Losing access to a
      // Google account should not lock anyone out of their own ledger.
      authFlows: { userSrp: true },
      // Short access tokens, long refresh — a leaked access token expires
      // quickly, and the refresh token is what the browser has to guard.
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      // Do not leak whether an email is registered.
      preventUserExistenceErrors: true,
    });

    // ---------------------------------------------------------------- outputs

    new cdk.CfnOutput(this, "LedgerTableName", { value: this.table.tableName });
    new cdk.CfnOutput(this, "RawBucketName", { value: this.rawBucket.bucketName });
    new cdk.CfnOutput(this, "UserPoolId", { value: this.userPool.userPoolId });
    // Explicit, because registerIdentityProvider did not produce a DependsOn.
    // Without it CloudFormation updates the client — which lists Google among
    // its supported providers — before the provider exists, and fails with
    // "The provider Google does not exist for User Pool".
    if (googleProvider) this.userPoolClient.node.addDependency(googleProvider);

    new cdk.CfnOutput(this, "UserPoolClientId", { value: this.userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, "HostedUiDomain", {
      value: `${settings.hostedUiPrefix}.auth.${this.region}.amazoncognito.com`,
    });

    cdk.Tags.of(this).add("app", config.appName);
    cdk.Tags.of(this).add("env", settings.name);
    cdk.Tags.of(this).add("tier", "data");
  }
}
