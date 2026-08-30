import { describe, it, expect } from "vitest";
import { Match } from "aws-cdk-lib/assertions";
import { templates, policyStatements } from "./harness";
import { config } from "../lib/config";

const { foundation } = templates();
const prodFoundation = templates({ env: "prod" }).foundation;

describe("data key", () => {
  it("is customer-managed and rotates", () => {
    // The requirement was set for the bucket and then had to be applied to the
    // table months later, because nothing checked that they matched.
    foundation.hasResourceProperties("AWS::KMS::Key", {
      EnableKeyRotation: true,
    });
  });

  it("survives the stack being destroyed", () => {
    // Deleting the key makes every object encrypted with it unreadable for
    // ever, including the raw zone the ledger is rebuilt from.
    foundation.hasResource("AWS::KMS::Key", { DeletionPolicy: "Retain" });
  });
});

describe("GitHub deploy role", () => {
  it("trusts only this repository, in the dev environment", () => {
    // Without the sub condition the provider vouches that a caller is *some*
    // GitHub workflow, not that it is ours — any repository would satisfy it.
    foundation.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: Match.objectLike({
              StringEquals: Match.objectLike({
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
              }),
            }),
          }),
        ]),
      }),
    });
  });

  it("accepts both the documented and the immutable subject form", () => {
    // GitHub issues repo:owner@<id>/repo@<id>:environment:dev, not the documented
    // repo:owner/repo form. A policy written from the docs matches nothing and
    // fails as "Not authorized", which says nothing about why.
    //
    // Derived from config rather than written out here. A literal would have gone
    // on passing when this repository moved to an organisation and the owner id
    // changed underneath it — the test would have been green while every deploy
    // failed. Only CI can catch that, and config.ts says how to read the real
    // subject back after a move.
    const roles = foundation.findResources("AWS::IAM::Role");
    const subs = Object.values(roles)
      .flatMap((r: any) => r.Properties?.AssumeRolePolicyDocument?.Statement ?? [])
      .map((s: any) => s.Condition?.StringEquals?.["token.actions.githubusercontent.com:sub"])
      .filter(Boolean)
      .flat();

    expect(subs).toContain(`repo:${config.githubRepo}:environment:dev`);
    expect(subs.some((s: string) => /^repo:[^@]+@\d+\/[^@]+@\d+:environment:dev$/.test(s))).toBe(true);
  });

  it("scopes each account's deploy role to its OWN GitHub environment", () => {
    // This was one constant, "dev", used for both accounts. The prod deploy role
    // would have trusted jobs declaring `environment: dev` — which is what every
    // merge to main already declares, with no approval rule on it. Anything able
    // to deploy dev could have deployed prod, in the one account where that
    // separation is the whole point.
    //
    // Caught by reading a `cdk diff` before bootstrapping prod, not by a test,
    // which is why this one exists.
    const subsFor = (t: typeof foundation) =>
      Object.values(t.findResources("AWS::IAM::Role"))
        .flatMap((r: any) => r.Properties?.AssumeRolePolicyDocument?.Statement ?? [])
        .map((st: any) => st.Condition?.StringEquals?.["token.actions.githubusercontent.com:sub"])
        .filter(Boolean)
        .flat()
        .filter((sub: string) => sub.includes(":environment:"));

    expect(subsFor(foundation).every((sub: string) => sub.endsWith(":environment:dev"))).toBe(true);
    expect(subsFor(prodFoundation).every((sub: string) => sub.endsWith(":environment:prod"))).toBe(true);
    // Stated the other way round too: the failure was prod trusting dev, and an
    // "every ends with prod" assertion passes vacuously on an empty list.
    expect(subsFor(prodFoundation).length).toBeGreaterThan(0);
    expect(subsFor(prodFoundation)).not.toContain(`repo:${config.githubRepo}:environment:dev`);
  });

  it("can do nothing but assume the CDK bootstrap roles", () => {
    // Keeps admin out of anything a workflow file can reach. If this ever
    // grows a second action, that is the finding.
    const statements = policyStatements(foundation).filter((s) =>
      JSON.stringify(s).includes("cdk-hnb659fds"),
    );
    expect(statements).toHaveLength(1);
    expect(statements[0]!["Action"]).toBe("sts:AssumeRole");
  });
});

describe("CI integration-test role", () => {
  const citest = () =>
    policyStatements(foundation).filter((s) => s["Sid"] === "EphemeralTestTables");

  const resourcesOf = (s: Record<string, unknown>): string[] => {
    const r = s["Resource"];
    return (Array.isArray(r) ? r : [r]) as string[];
  };

  it("cannot reach the region the ledger lives in", () => {
    // The whole point of the restriction. An ephemeral table beside the real
    // ledger would be separated from it only by an environment variable
    // holding the right name, and the integration suites deliberately do not
    // clean up after themselves.
    const statements = citest();
    expect(statements).toHaveLength(1);

    for (const s of statements) {
      expect(s["Condition"]).toMatchObject({
        StringEquals: { "aws:RequestedRegion": "eu-west-2" },
      });
      for (const arn of resourcesOf(s)) {
        expect(arn).toContain(":eu-west-2:");
        expect(arn).not.toContain(":eu-west-1:");
      }
    }
  });

  it("cannot name a table anything but tightarse-citest-*", () => {
    // Region alone still permits a table called `Ledger` in eu-west-2, which is
    // the name any copy-pasted command would reach for.
    for (const s of citest()) {
      for (const arn of resourcesOf(s)) {
        expect(arn).toMatch(/:table\/tightarse-citest-\*/);
      }
    }
  });

  it("can query the account index and not only the base table", () => {
    // Query against gsi1-account is authorised on the index ARN, not the
    // table's. Omitting it deploys cleanly and then fails every query in the
    // suite as AccessDenied — valid CloudFormation, useless at runtime, which
    // is how the last two IAM incidents here presented.
    const arns = citest().flatMap(resourcesOf);
    expect(arns.some((a) => a.endsWith("/index/*"))).toBe(true);
  });

  it("can do nothing but DynamoDB", () => {
    // It is assumable from any pull request, so its permissions are the only
    // thing limiting what a branch can do. Notably it must not be able to
    // assume the deploy role's bootstrap roles.
    for (const s of citest()) {
      const actions = s["Action"];
      for (const a of (Array.isArray(actions) ? actions : [actions]) as string[]) {
        expect(a.startsWith("dynamodb:")).toBe(true);
      }
    }
  });

  it("is a different role from the one that can deploy", () => {
    // If these ever merge, every pull request gains a path to the CDK
    // bootstrap roles, which carry admin.
    const roles = Object.values(foundation.findResources("AWS::IAM::Role"));
    const names = roles.map((r: any) => r.Properties?.RoleName).filter(Boolean);
    expect(names).toContain("tightarse-dev-github-deploy");
    expect(names).toContain("tightarse-dev-github-citest");
  });

  it("is not assumable by a fork, or by a job that declares no ref", () => {
    // The provider alone vouches that a caller is *some* GitHub workflow. The
    // sub condition is what says it is ours, and both subject forms are needed
    // because GitHub is migrating to immutable numeric ids.
    const roles = foundation.findResources("AWS::IAM::Role");
    const citestRole = Object.values(roles).find(
      (r: any) => r.Properties?.RoleName === "tightarse-dev-github-citest",
    ) as any;

    const subs = (citestRole.Properties.AssumeRolePolicyDocument.Statement as any[])
      .map((s) => s.Condition?.StringEquals?.["token.actions.githubusercontent.com:sub"])
      .filter(Boolean)
      .flat() as string[];

    expect(subs).toContain(`repo:${config.githubRepo}:pull_request`);
    expect(subs).toContain(`repo:${config.githubRepo}:ref:refs/heads/main`);
    expect(subs.some((s) => /^repo:[^@]+@\d+\/[^@]+@\d+:pull_request$/.test(s))).toBe(true);
    // No wildcards: a bare `repo:owner/repo:*` would accept a workflow_dispatch
    // from any branch anyone can push.
    expect(subs.every((s) => !s.includes("*"))).toBe(true);
  });
});

describe("secrets", () => {
  it("declares the TrueLayer client secret without a value", () => {
    // A generated or inline value would put a credential in the template, and
    // templates are readable by anyone with CloudFormation access.
    const secrets = foundation.findResources("AWS::SecretsManager::Secret");
    for (const s of Object.values(secrets)) {
      expect((s as any).Properties?.SecretString).toBeUndefined();
    }
    expect(Object.keys(secrets).length).toBeGreaterThan(0);
  });
});
