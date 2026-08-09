import * as cdk from "aws-cdk-lib";

/**
 * Deployment configuration.
 *
 * eu-west-1 (Ireland) rather than eu-west-2 (London): London supports only
 * AgentCore Gateway, Identity and Memory — not AgentCore Runtime, which is
 * what hosts the Strands agents. UK GDPR adequacy covers EU storage.
 */
export const config = {
  region: "eu-west-1",
  appName: "tightarse",
  /** Ingest cadence. Unattended open banking access is capped at 4 calls per
   *  24h per consent, so daily leaves plenty of headroom for manual refreshes. */
  ingestScheduleCron: { minute: "0", hour: "5" },
  /** Nudge for consent reconfirmation this many days after it was granted.
   *  Consent lapses at 90 days; 80 leaves time to act. */
  consentReconfirmNudgeDays: 80,
} as const;

export type EnvName = "dev" | "prod";

/**
 * Per-environment durability.
 *
 * dev is meant to be thrown away — the whole point of a separate account is
 * that we can wipe it when a schema decision turns out badly. prod holds five
 * years of family financial data that cost a bank consent to acquire, and is
 * protected accordingly.
 */
export interface EnvSettings {
  readonly name: EnvName;
  readonly removalPolicy: cdk.RemovalPolicy;
  readonly deletionProtection: boolean;
  readonly pointInTimeRecovery: boolean;
  /** Empty the raw bucket on stack deletion. Only ever true in dev. */
  readonly autoDeleteObjects: boolean;
  /** How long raw landing-zone objects are kept. See the retention notes on #15. */
  readonly rawRetentionDays: number;
  /**
   * Days before raw objects move to Infrequent Access, or undefined for no
   * transition. Must be strictly less than rawRetentionDays — S3 rejects the
   * lifecycle rule otherwise. Short-lived objects should not transition at all:
   * IA bills a 30-day minimum, so moving something you are about to delete
   * costs more than leaving it in Standard.
   */
  readonly rawTransitionToIaDays?: number;
}

const SETTINGS: Record<EnvName, EnvSettings> = {
  dev: {
    name: "dev",
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    deletionProtection: false,
    // Not worth paying for in an account we intend to wipe.
    pointInTimeRecovery: false,
    autoDeleteObjects: true,
    rawRetentionDays: 30,
    // No IA transition: 30 days is inside IA's minimum billing duration.
  },
  prod: {
    name: "prod",
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    deletionProtection: true,
    pointInTimeRecovery: true,
    autoDeleteObjects: false,
    // Long enough to survive a transform rewrite, not indefinite.
    rawRetentionDays: 365,
    rawTransitionToIaDays: 30,
  },
};

/**
 * Resolved from CDK context: `cdk deploy -c env=prod`. Defaults to dev, so the
 * destructive settings are never the accident — you have to ask for prod.
 */
export function envSettings(scope: cdk.App): EnvSettings {
  const raw: unknown = scope.node.tryGetContext("env") ?? "dev";
  if (raw !== "dev" && raw !== "prod") {
    throw new Error(`Unknown env ${JSON.stringify(raw)} — expected "dev" or "prod"`);
  }
  return SETTINGS[raw];
}

/**
 * SSM parameter path holding a TrueLayer refresh token for one connection.
 *
 * Deliberately NOT a CDK resource. CloudFormation cannot create SecureString
 * parameters, and we would not want token material passing through a template
 * anyway — the connect flow writes these at runtime. The stack only defines
 * the path convention and grants access to it.
 */
export function tokenParameterPrefix(env: EnvName): string {
  return `/${config.appName}/${env}/truelayer/connections`;
}
