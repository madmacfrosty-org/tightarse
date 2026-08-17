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
  /** The only repository allowed to assume the deploy role. */
  githubRepo: "madmacfrosty/tightarse",
  /**
   * The GitHub environment CI deploys through.
   *
   * Trust is scoped to the environment rather than to a branch, because an
   * environment is what carries an approval rule. Add required reviewers in
   * the repository settings and every deploy waits for a human; leave it bare
   * and merges to main deploy straight through. The trust policy does not have
   * to change either way.
   */
  githubEnvironment: "dev",
  /**
   * The repository's OIDC subject prefix, including GitHub's immutable ids.
   *
   * GitHub has begun issuing subject claims of the form
   * `repo:owner@<ownerId>/repo@<repoId>` rather than the documented
   * `repo:owner/repo`. A trust policy written from the documentation matches
   * nothing, and the failure reads "Not authorized to perform
   * sts:AssumeRoleWithWebIdentity" with no indication that the subject is the
   * problem.
   *
   * Read it back with:
   *   gh api /repos/<owner>/<repo>/actions/oidc/customization/sub
   *
   * Both forms are trusted below. The immutable one is strictly better — a
   * rename, or someone later claiming the abandoned name, cannot satisfy it.
   */
  githubSubjectPrefixImmutable: "repo:madmacfrosty@10167941/tightarse@1328000897",
  /**
   * Region for integration tests that need a real DynamoDB.
   *
   * Deliberately not `region`. An ephemeral test table in eu-west-1 would sit
   * beside the ledger, and the only thing keeping the two apart would be an
   * environment variable holding the right table name. Putting the tests in a
   * different region means the credential itself can be denied eu-west-1, so
   * reaching real data is impossible rather than merely discouraged.
   *
   * London hosts no AgentCore Runtime, which is why the app is not here — but
   * a test table needs nothing but DynamoDB.
   */
  citestRegion: "eu-west-2",
  /**
   * The only table names CI may create, and the second half of the restriction.
   *
   * Region alone would still allow a table called `Ledger` in eu-west-2, which
   * is exactly the name a copy-pasted command would use.
   */
  citestTablePrefix: "tightarse-citest-",
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
  /**
   * Google OAuth client id, or undefined where federation is not configured.
   *
   * Config rather than CDK context. It was context while the Google project did
   * not exist, so the stack stayed deployable without it — but that made
   * forgetting the flag silently remove the identity provider, and CloudFormation
   * then refused to drop an export the deployed stack still used. A deploy
   * should not depend on remembering a flag.
   *
   * Not a secret: it is sent to every browser that reaches the sign-in page.
   */
  readonly googleClientId?: string;
  /**
   * Cognito hosted-UI domain prefix.
   *
   * A fixed literal, not derived from the account id. Deriving it looked
   * tidier but only worked when the account was resolved — at synth without
   * credentials `this.account` is an unresolved token, the prefix became
   * invalid, and `cdk synth` failed. CI has no credentials, so that would have
   * broken the build rather than a deploy.
   *
   * The numeric suffix is an opaque uniqueness token: Cognito domain prefixes
   * are globally unique across all AWS accounts.
   */
  readonly hostedUiPrefix: string;
  /**
   * Prefix for the replacement pool being stood up alongside the first.
   *
   * A second prefix is needed rather than reusing the first, because Cognito
   * domain prefixes are globally unique across every AWS account and both pools
   * exist at once during the changeover. See #36.
   */
  readonly hostedUiPrefixV2: string;
  /**
   * Where the dashboard is served from, once its distribution exists.
   *
   * Held here rather than passed as CDK context, because context supplied on the
   * command line is not persisted: a manual `-c siteUrl=…` deploy followed by
   * any CI deploy would silently drop the callback URL from the user pool and
   * revert the bank redirect to localhost, breaking the deployed site on the
   * next merge with nothing in the diff to explain it.
   *
   * `undefined` before the distribution has been created — the domain is not
   * known until CloudFront assigns it, so this is written once after the first
   * deploy and is stable thereafter.
   */
  readonly siteUrl?: string;
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
    googleClientId: "242040418333-3re7ehr425qst2ghgf8eh1qk263noe19.apps.googleusercontent.com",
    hostedUiPrefix: "tightarse-dev-068475",
    hostedUiPrefixV2: "tightarse-dev-068475-b",
    siteUrl: "https://d235jlz4kj7lqs.cloudfront.net",
    rawRetentionDays: 30,
    // No IA transition: 30 days is inside IA's minimum billing duration.
  },
  prod: {
    name: "prod",
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    deletionProtection: true,
    pointInTimeRecovery: true,
    autoDeleteObjects: false,
    hostedUiPrefix: "tightarse-prod-068475",
    hostedUiPrefixV2: "tightarse-prod-068475-b",
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
 * Secrets Manager name prefix for this environment.
 *
 * Lives in FoundationStack, which is never destroyed — so Secrets Manager's
 * 7-30 day recovery window, which would otherwise block redeploying a wiped
 * dev stack under the same name, is not a constraint.
 */
export function secretPrefix(env: EnvName): string {
  return `${config.appName}/${env}/truelayer`;
}

/**
 * Where the bank sends the browser back after an authorisation.
 *
 * Derived from `siteUrl` rather than configured separately, because the two must
 * agree and a second field is a second thing to get wrong — the same reasoning
 * that put the pool, its client and its hosted UI into one object.
 *
 * Falls back to the local dev server when no site is deployed yet. Whichever
 * value this returns must be registered with TrueLayer as an allowed redirect
 * URI: the provider matches it exactly and refuses anything else, and nothing in
 * CDK can register it.
 */
export function connectRedirectUri(settings: EnvSettings): string {
  return settings.siteUrl === undefined
    ? "http://localhost:5173/connected"
    : `${settings.siteUrl}/connected`;
}
