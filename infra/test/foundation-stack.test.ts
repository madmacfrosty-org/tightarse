import { describe, it, expect } from "vitest";
import { Match } from "aws-cdk-lib/assertions";
import { templates, policyStatements } from "./harness";

const { foundation } = templates();

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
    // GitHub issues repo:owner@<id>/repo@<id>:environment:dev, not the
    // documented repo:owner/repo form. A policy written from the docs matches
    // nothing and fails as "Not authorized", which says nothing about why.
    const roles = foundation.findResources("AWS::IAM::Role");
    const subs = Object.values(roles)
      .flatMap((r: any) => r.Properties?.AssumeRolePolicyDocument?.Statement ?? [])
      .map((s: any) => s.Condition?.StringEquals?.["token.actions.githubusercontent.com:sub"])
      .filter(Boolean)
      .flat();

    expect(subs).toContain("repo:madmacfrosty/tightarse:environment:dev");
    expect(subs.some((s: string) => /^repo:[^@]+@\d+\/[^@]+@\d+:environment:dev$/.test(s))).toBe(true);
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
