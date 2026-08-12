import * as cdk from "aws-cdk-lib";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as kms from "aws-cdk-lib/aws-kms";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { config, secretPrefix, type EnvSettings } from "./config";

export interface FoundationStackProps extends cdk.StackProps {
  readonly settings: EnvSettings;
}

/**
 * Long-lived foundations. **Never destroyed, in any environment.**
 *
 * This exists because of one asymmetry: wiping dev is meant to undo a schema
 * decision, not to cost a trip through a bank's authorisation journey. If
 * refresh tokens lived alongside the ledger, every `cdk destroy` on the data
 * stack would force a re-consent. Here they survive it.
 *
 * That also removes the objection to Secrets Manager. Its 7-30 day recovery
 * window blocks reusing a secret name after deletion — irrelevant for a stack
 * that is never deleted, which leaves the rotation, resource policies and
 * cross-account access it is genuinely good at.
 *
 * A VPC would belong here too, if one is ever needed. It is not today:
 * DynamoDB, S3, Lambda, API Gateway, Cognito and AgentCore Runtime are all
 * VPC-less, and a NAT gateway alone would cost an order of magnitude more than
 * the rest of the infrastructure combined.
 */
export class FoundationStack extends cdk.Stack {
  /** TrueLayer application credential. Static, one per environment. */
  public readonly clientSecret: secretsmanager.Secret;

  /** Name prefix for per-connection refresh tokens, created at runtime. */
  public readonly connectionSecretPrefix: string;

  /**
   * Customer-managed key for the raw landing zone.
   *
   * Lives here, not with the bucket, for two reasons. KMS deletion is
   * irreversible behind a mandatory 7-30 day window, so a key must never sit
   * in a stack that gets wiped. And destroying and recreating the data stack
   * must not orphan the key that its previous objects were encrypted under.
   *
   * The point of a CMK rather than SSE-S3 is that it makes an IAM `Deny
   * kms:Decrypt` meaningful. With SSE-S3, decryption is transparent to anyone
   * holding s3:GetObject — so the CDK lookup role's deny, which is how
   * read-only access is kept away from bank data, would do nothing at all.
   */
  public readonly dataKey: kms.Key;

  /** Google OAuth client secret, populated by hand. */
  public readonly googleOAuthSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);

    const { settings } = props;
    const prefix = secretPrefix(settings.name);

    this.clientSecret = new secretsmanager.Secret(this, "TrueLayerClientSecret", {
      secretName: `${prefix}/client-secret`,
      description: `TrueLayer client credentials for ${settings.name}. Set by hand — see README.`,
      // A placeholder is generated so no credential material ever passes
      // through a CloudFormation template. Overwrite it with the real value:
      //   aws secretsmanager put-secret-value --secret-id <name> \
      //     --secret-string '{"clientId":"...","clientSecret":"..."}'
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ clientId: "", clientSecret: "" }),
        generateStringKey: "placeholder",
      },
      // Retained even in dev — that is the entire point of this stack.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    /**
     * Google OAuth client secret, for federated sign-in.
     *
     * Here rather than in DataStack for the same reason as everything else in
     * this stack: it is obtained by hand from a Google Cloud project and
     * re-obtaining it is a manual chore, so wiping dev data must not destroy it.
     *
     * Created with a generated placeholder — no credential passes through a
     * CloudFormation template. Overwrite with the real value:
     *   aws secretsmanager put-secret-value --secret-id <name> \
     *     --secret-string '{"clientSecret":"..."}'
     */
    this.googleOAuthSecret = new secretsmanager.Secret(this, "GoogleOAuth", {
      secretName: `${prefix.replace("/truelayer", "")}/google-oauth`,
      description: `Google OAuth client secret for ${settings.name}`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ clientSecret: "" }),
        generateStringKey: "placeholder",
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.dataKey = new kms.Key(this, "DataKey", {
      alias: `alias/${config.appName}-${settings.name}-data`,
      description: `Encrypts ${settings.name} household financial data: raw landing zone and ledger table`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Per-connection secrets cannot be declared: there is one per bank
    // connection and they are created by the connect flow at runtime. The
    // stack owns the naming convention and the IAM boundary instead.
    this.connectionSecretPrefix = `${prefix}/connections`;

    // ------------------------------------------------------- CI deploy role
    //
    // GitHub Actions deploying without a stored AWS key.
    //
    // The alternative is an access key in GitHub secrets, which works from
    // anywhere, for anyone holding it, until somebody remembers to rotate it.
    // Here GitHub signs a token describing one workflow run, AWS trusts that
    // signature, and STS exchanges it for credentials lasting an hour. There is
    // no secret to leak, because nothing that works outside a run is stored.
    //
    // Note this does NOT remove the long-lived key on the maintainer's laptop.
    // That is a different problem with a different answer (Identity Center).
    const githubOidc = new iam.OpenIdConnectProvider(this, "GitHubOidc", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });

    const deployRole = new iam.Role(this, "GitHubDeployRole", {
      roleName: `${config.appName}-${settings.name}-github-deploy`,
      description: "Assumed by GitHub Actions to deploy this app. No standing credentials.",
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(githubOidc.openIdConnectProviderArn, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          // Scoped to one repository AND one environment. Without the sub
          // condition any repository on GitHub could assume this role — the
          // provider alone vouches that a caller is *some* GitHub workflow,
          // not that it is ours.
          //
          // Two exact values, no wildcards. GitHub now issues immutable
          // subjects carrying numeric ids, and the documented form is what a
          // trust policy gets written against; accepting both means this keeps
          // working whichever GitHub sends.
          "token.actions.githubusercontent.com:sub": [
            `${config.githubSubjectPrefixImmutable}:environment:${config.githubEnvironment}`,
            `repo:${config.githubRepo}:environment:${config.githubEnvironment}`,
          ],
        },
      }),
    });

    // The role can do exactly one thing: assume the CDK bootstrap roles, which
    // carry the actual deployment permissions and are themselves scoped. This
    // keeps admin out of a role that a workflow file can reach.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*-${this.account}-${config.region}`],
      }),
    );

    new cdk.CfnOutput(this, "GitHubDeployRoleArn", { value: deployRole.roleArn });

    new cdk.CfnOutput(this, "ClientSecretName", { value: this.clientSecret.secretName });
    new cdk.CfnOutput(this, "ConnectionSecretPrefix", { value: this.connectionSecretPrefix });
    new cdk.CfnOutput(this, "DataKeyArn", { value: this.dataKey.keyArn });
    new cdk.CfnOutput(this, "GoogleOAuthSecretName", { value: this.googleOAuthSecret.secretName });

    cdk.Tags.of(this).add("app", config.appName);
    cdk.Tags.of(this).add("env", settings.name);
    cdk.Tags.of(this).add("tier", "foundation");
  }

  /** Read the TrueLayer application credential. */
  public grantClientSecretRead(grantee: iam.IGrantable): void {
    this.clientSecret.grantRead(grantee);
  }

  /**
   * Manage per-connection refresh tokens.
   *
   * Scoped to the naming prefix rather than to individual ARNs, because the
   * secrets do not exist at deploy time. Secrets Manager appends a random
   * suffix to every ARN, hence the trailing wildcard.
   */
  public grantConnectionSecrets(grantee: iam.IGrantable): void {
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          "secretsmanager:CreateSecret",
          "secretsmanager:GetSecretValue",
          "secretsmanager:PutSecretValue",
          "secretsmanager:UpdateSecret",
          "secretsmanager:DescribeSecret",
          "secretsmanager:TagResource",
          // Erasure requests have to be able to remove a household's tokens.
          "secretsmanager:DeleteSecret",
        ],
        resources: [
          cdk.Arn.format(
            { service: "secretsmanager", resource: "secret", resourceName: `${this.connectionSecretPrefix}/*`, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME },
            this,
          ),
        ],
      }),
    );
  }
}
