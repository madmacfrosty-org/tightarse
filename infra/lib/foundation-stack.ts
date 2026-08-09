import * as cdk from "aws-cdk-lib";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
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
 * the rest of the infrastructure combined. Same for a customer-managed KMS key.
 */
export class FoundationStack extends cdk.Stack {
  /** TrueLayer application credential. Static, one per environment. */
  public readonly clientSecret: secretsmanager.Secret;

  /** Name prefix for per-connection refresh tokens, created at runtime. */
  public readonly connectionSecretPrefix: string;

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

    // Per-connection secrets cannot be declared: there is one per bank
    // connection and they are created by the connect flow at runtime. The
    // stack owns the naming convention and the IAM boundary instead.
    this.connectionSecretPrefix = `${prefix}/connections`;

    new cdk.CfnOutput(this, "ClientSecretName", { value: this.clientSecret.secretName });
    new cdk.CfnOutput(this, "ConnectionSecretPrefix", { value: this.connectionSecretPrefix });

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
