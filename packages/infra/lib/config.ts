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
  githubRepo: "madmacfrosty-org/tightarse",
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
   * Both forms are trusted below. The immutable one survives a rename, and stops
   * someone later claiming an abandoned name from satisfying it.
   *
   * It does NOT survive a transfer between accounts. Moving this repository from
   * a personal account to an organisation kept the repo id and changed the owner
   * id — 10167941 became 319502408 — so both forms stopped matching at once and
   * every deploy failed with "Not authorized to perform
   * sts:AssumeRoleWithWebIdentity", which names nothing that would lead you here.
   *
   * Read it back after any move:
   *   gh api /repos/<owner>/<repo>/actions/oidc/customization/sub
   */
  githubSubjectPrefixImmutable: "repo:madmacfrosty-org@319502408/tightarse@1328000897",
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
  /**
   * The GitHub environment whose jobs may assume this account's deploy role.
   *
   * Per environment, and it has to be: this was one constant, "dev", used for
   * both. A prod account bootstrapped from it would have trusted jobs declaring
   * `environment: dev` — which is what every merge to main already declares, with
   * no approval rule on it. The separation the environment scoping exists for
   * would have been absent in exactly the account that needs it.
   *
   * Trust is scoped to the environment rather than to a branch because an
   * environment is what carries an approval rule. Add required reviewers in the
   * repository settings and every deploy waits for a human; leave it bare and
   * merges deploy straight through. The trust policy does not change either way.
   */
  readonly githubEnvironment: string;
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
   * The numeric suffix is a uniqueness token — Cognito domain prefixes are
   * globally unique across every AWS account — and by convention the last six
   * digits of the account it belongs to.
   *
   * "Opaque" is what this said before, which is how prod came to carry dev's
   * digits: nothing reads the suffix, so nothing broke, and a value that is
   * wrong but harmless is one nobody checks. Matching the account makes it
   * verifiable at a glance.
   *
   * Still named V2 now the original is gone (#37). The name is load-bearing:
   * the prefix is part of a live hosted-UI domain, registered as a redirect URI
   * with Google and referenced by every deployed callback. Renaming the field
   * is free; renaming the value is not, so the field keeps the value's name.
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
  /**
   * A domain of our own for the dashboard, or undefined to use CloudFront's.
   *
   * One field holding both, because CloudFront rejects a domain without a
   * certificate at deploy and a certificate without a domain does nothing. Two
   * optional fields made "both or neither" a rule to be checked; one optional
   * object makes the broken combinations unrepresentable.
   *
   * A subdomain rather than the apex: DNS forbids a CNAME at a zone apex, so an
   * apex would need a Route 53 alias record and therefore the whole zone moved
   * off its current registrar — a migration of a domain used for other things,
   * to save one label in a URL.
   *
   * The certificate is an ARN rather than a Certificate construct, and must be in
   * us-east-1: CloudFront reads certificates only from there whatever region it
   * serves, and DNS validation blocks stack creation until someone adds a record
   * at the registrar, so creating one here would leave a deploy hanging on a
   * human.
   */
  readonly web?: { readonly domainName: string; readonly certificateArn: string };
  /**
   * Whether this deployment refreshes bank connections.
   *
   * A connection's refresh token rotates on every use and the previous one is
   * invalidated, so two deployments holding the same connection destroy it: the
   * second to refresh presents a token the first has already spent, and both
   * write back what they got. `connections.ts` describes the result as the
   * difference between a connection that keeps working and one that dies
   * quietly a few days later.
   *
   * The cutover therefore needs exactly one deployment syncing at a time, and
   * this is how that is stated. It gates the refresh, not the connect flow —
   * establishing a connection creates a token rather than spending one, and a
   * deployment that cannot connect could never be set up at all.
   *
   * Deliberately not `events.Rule.enabled`. Disabling the schedule stops the
   * daily trigger and leaves a manual execution free to refresh; this sits in
   * the path that touches the token, so every route through it is covered.
   * Deliberately not a runtime toggle either: a value flipped in a console is
   * drift, and the next deploy silently reverts it with nothing in the diff to
   * say so. `aws events disable-rule` remains available as an emergency brake,
   * which is safe precisely because the durable answer lives here.
   */
  readonly syncEnabled: boolean;
  /**
   * Which TrueLayer to talk to.
   *
   * `sandbox` reaches a mock bank and mints consents that are not a real
   * household's. That is the whole point of it: the connect flow cannot be
   * exercised against `live` without spending a real consent, and roughly an
   * hour after one is granted only ninety days of history remain available,
   * for ever. A flow whose mistakes are unrecoverable needs somewhere to be
   * got wrong.
   *
   * Dev is sandbox and prod is live, and that pairing is not a coincidence:
   * dev is the account with `RemovalPolicy.DESTROY` on everything, and a
   * credential reaching a real bank does not belong in it. See ADR-0003.
   */
  readonly providerEnvironment: "sandbox" | "live";
  /**
   * The household this deployment syncs.
   *
   * Was the literal "frost" in both, which is prod's household and is empty in
   * dev — 0 rows against 315 for `demo-one`, the household every dev member
   * actually belongs to. So dev's sync was aimed at a household nobody could
   * see, and would have fetched nothing for anybody.
   *
   * Dormant until 4 October 2026 because dev's sync had been disabled since
   * the August cutover. Turning it back on surfaced it immediately: a
   * connection made through dev's own dashboard was stored under `demo-one`
   * and the sync failed with "No connection … for this household".
   */
  readonly tenantId: string;
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

export const SETTINGS: Record<EnvName, EnvSettings> = {
  dev: {
    name: "dev",
    githubEnvironment: "dev",
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    deletionProtection: false,
    // Not worth paying for in an account we intend to wipe.
    pointInTimeRecovery: false,
    autoDeleteObjects: true,
    googleClientId: "242040418333-3re7ehr425qst2ghgf8eh1qk263noe19.apps.googleusercontent.com",
    hostedUiPrefixV2: "tightarse-dev-068475-b",
    siteUrl: "https://d235jlz4kj7lqs.cloudfront.net",
    // True from 30 September 2026, and only because of the line below it.
    //
    // False from the cutover on 23 August because dev held a copy of prod's
    // *live* credential: a dev refresh spent a token prod was holding, and the
    // connection died days later (#43, ADR-0003). The hazard was the shared
    // live credential rather than the act of refreshing, and it went when the
    // credential did.
    //
    // On sandbox there is no such token — the connections are a mock bank's
    // and nothing prod holds is reachable from here. It has to be true for the
    // renewal flow to be exercisable at all: the Connections page reads consent
    // rows, and the sync is what writes them, so a deployment that never syncs
    // shows an empty page with nothing to renew. `liveSyncIsProdAlone` fails
    // the build if anyone ever points a syncing dev at live.
    syncEnabled: true,
    // Sandbox, so the connect flow and the reconsent that follows it can be
    // exercised without spending anything a household would miss.
    providerEnvironment: "sandbox",
    // The demo household, which is the one dev's members belong to.
    tenantId: "demo-one",
    rawRetentionDays: 30,
    // No IA transition: 30 days is inside IA's minimum billing duration.
  },
  prod: {
    name: "prod",
    githubEnvironment: "prod",
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    deletionProtection: true,
    pointInTimeRecovery: true,
    autoDeleteObjects: false,
    googleClientId: "242040418333-ph17hhc226sb913d8968eg0qr2dod3u8.apps.googleusercontent.com",
    hostedUiPrefixV2: "tightarse-prod-312637-b",
    web: {
      domainName: "tightarse.madmacfrosty.co.uk",
      certificateArn: "arn:aws:acm:us-east-1:960946312637:certificate/3b8eddc2-9d2c-45cd-8a72-3442a037ff51",
    },
    /**
     * Known before the distribution exists, because the name is ours.
     *
     * dev had to deploy once, read CloudFront's assigned domain, write it here
     * and deploy again — and everything derived from it (the bank redirect, the
     * Cognito callback, the CSP) was wrong in between. A domain we control breaks
     * that circularity: the address is decided first and the infrastructure is
     * pointed at it.
     */
    siteUrl: "https://tightarse.madmacfrosty.co.uk",
    syncEnabled: true,
    providerEnvironment: "live",
    tenantId: "frost",
    // Long enough to survive a transform rewrite, not indefinite.
    rawRetentionDays: 365,
    rawTransitionToIaDays: 30,
  },
};

/**
 * Only one deployment may ever refresh a live consent.
 *
 * `syncEnabled` and `providerEnvironment` are safe in three of their four
 * combinations and catastrophic in the fourth, and nothing about reading either
 * one alone says which you are in. Dev syncing is fine because dev is on
 * sandbox; the day somebody moves it to live to chase a bug, that same `true`
 * becomes a second deployment spending prod's tokens — the failure ADR-0003
 * and #43 are both about, which shows up days later as a dead connection.
 *
 * Checked over the whole table rather than the selected environment, so `cdk
 * deploy` fails whichever one is being deployed. A synth-time throw is the
 * point: this cannot become a review comment somebody misses.
 */
export function liveSyncIsProdAlone(settings: Record<string, EnvSettings>): void {
  const live = Object.values(settings).filter(
    (s) => s.syncEnabled && s.providerEnvironment === "live",
  );
  if (live.length > 1 || (live[0] !== undefined && live[0].name !== "prod")) {
    throw new Error(
      `Only prod may sync against live TrueLayer; found ${live.map((s) => s.name).join(", ")}`,
    );
  }
}

/**
 * Whether a deployment may act on the connections it holds.
 *
 * Distinct from `syncEnabled`, which says whether it refreshes them on a
 * schedule. This says whether it owns them at all — and the answer is the same
 * rule `liveSyncIsProdAlone` enforces: the live connections belong to prod, and
 * a sandbox deployment owns its own, which are a mock bank's and cost nothing
 * to spend.
 *
 * Named rather than folded into `syncEnabled` because reading renewal
 * permission off a flag called "sync" is how the two get conflated. They were,
 * briefly: dev was refused renewal because it does not run a daily sync, which
 * is not the question.
 */
export function ownsConnections(settings: EnvSettings): boolean {
  return settings.providerEnvironment === "sandbox" || settings.name === "prod";
}

liveSyncIsProdAlone(SETTINGS);

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
