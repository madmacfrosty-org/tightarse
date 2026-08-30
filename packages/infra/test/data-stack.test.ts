import { describe, it, expect } from "vitest";
import { Match } from "aws-cdk-lib/assertions";
import { templates } from "./harness";

const dev = templates();
const prod = templates({ env: "prod" });

describe("ledger table", () => {
  it("is keyed pk/sk with the account index", () => {
    dev.data.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: "gsi1-account" }),
      ]),
    });
  });

  it("is encrypted with the customer-managed key, not the AWS default", () => {
    // It was on the AWS-managed default for months — "the key that protects my
    // DynamoDB data when no other key is defined", which is what it says:
    // nobody chose it. The bucket had a CMK; the table holds the same data.
    const tables = dev.data.findResources("AWS::DynamoDB::GlobalTable");
    for (const t of Object.values(tables)) {
      const replicas = (t as any).Properties?.Replicas ?? [];
      expect(replicas.length).toBeGreaterThan(0);
      for (const r of replicas) {
        expect(r.SSESpecification?.KMSMasterKeyId).toBeDefined();
      }
    }
  });

  it("is destroyable in dev and retained in prod", () => {
    dev.data.hasResource("AWS::DynamoDB::GlobalTable", { DeletionPolicy: "Delete" });
    prod.data.hasResource("AWS::DynamoDB::GlobalTable", { DeletionPolicy: "Retain" });
  });
});

describe("raw landing zone", () => {
  it("blocks public access and requires TLS", () => {
    dev.data.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: "Enabled" },
    });
  });

  it("expires objects after the retention period", () => {
    const buckets = dev.data.findResources("AWS::S3::Bucket");
    const rules = Object.values(buckets)
      .flatMap((b: any) => b.Properties?.LifecycleConfiguration?.Rules ?? []);
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) expect(r.ExpirationInDays).toBeGreaterThan(0);
  });

  it("never expires an object before it has finished transitioning", () => {
    // A deploy failed on exactly this: expiration must exceed the transition,
    // and IA carries a 30-day minimum charge, so the two are coupled.
    const buckets = prod.data.findResources("AWS::S3::Bucket");
    for (const b of Object.values(buckets)) {
      for (const r of (b as any).Properties?.LifecycleConfiguration?.Rules ?? []) {
        for (const t of r.Transitions ?? []) {
          expect(r.ExpirationInDays).toBeGreaterThan(t.TransitionInDays);
        }
      }
    }
  });
});

describe("identity", () => {
  it("gives the pool its provider where a client id is supplied", () => {
    // One per environment since #37 retired the original pool. It was two while
    // both existed, because an identity provider belongs to a pool and cannot be
    // shared — so a count of two here now means a pool nobody meant to create.
    expect(Object.keys(dev.data.findResources("AWS::Cognito::UserPoolIdentityProvider"))).toHaveLength(1);
    expect(Object.keys(prod.data.findResources("AWS::Cognito::UserPoolIdentityProvider"))).toHaveLength(1);
  });

  it("configures no federation where a client id is absent", () => {
    // A deploy without one comes up with email and password only, and adding the
    // provider afterwards means CloudFormation refusing to drop an export the
    // stack still uses — which is #36 from the other direction.
    //
    // Tested against a synthesised environment rather than whichever one happens
    // to lack a client id. It used to read prod, which had none; prod got one and
    // this would have stopped testing anything without failing to say so.
    const none = templates({}, { googleClientId: undefined });
    expect(Object.keys(none.data.findResources("AWS::Cognito::UserPoolIdentityProvider"))).toHaveLength(0);
  });

  it("gives the pool a mutable email, which is the whole reason it exists", () => {
    // #36 in one assertion. Cognito re-applies an identity provider's attribute
    // mapping on every federated sign-in, so an immutable email makes the first
    // Google sign-in succeed and every one after it fail with "user.email:
    // Attribute cannot be updated". A pool's schema is fixed at creation, so the
    // original could not be repaired — it had to be replaced, and #37 deleted it.
    //
    // Every pool, not the first one found: a false here is the defect returning.
    const pools = Object.values(dev.data.findResources("AWS::Cognito::UserPool"));
    expect(pools).toHaveLength(1);
    for (const pool of pools) {
      const email = (pool as any).Properties.Schema.find((a: any) => a.Name === "email");
      expect(email?.Mutable, "an immutable email is #36 all over again").toBe(true);
    }
  });

  it("accepts the deployed site and localhost as callbacks", () => {
    // Both, deliberately: the dashboard is served from CloudFront and is also
    // run locally against the same deployed API, and a pool that only knows one
    // of them breaks whichever is missing.
    //
    // The site URL comes from settings rather than CDK context. Context given on
    // the command line is not persisted, so a manual deploy followed by any CI
    // deploy would silently drop the callback and break sign-in on the deployed
    // site, with nothing in the diff to explain it.
    const clients = Object.values(dev.data.findResources("AWS::Cognito::UserPoolClient"));
    for (const c of clients) {
      const urls = (c as any).Properties.CallbackURLs as string[];
      expect(urls, "localhost must stay usable").toContain("http://localhost:5173");
      expect(urls.some((u) => u.includes("cloudfront.net")), `callbacks were ${urls}`).toBe(true);
    }
  });

  it("gives each environment one hosted UI prefix, and never the same one", () => {
    // Cognito domain prefixes are globally unique across every AWS account, so
    // dev and prod cannot share one even though they are separate accounts.
    // There were two per environment while both pools existed; #37 leaves one.
    const prefixesOf = (t: typeof dev.data) =>
      Object.values(t.findResources("AWS::Cognito::UserPoolDomain")).map((d: any) => d.Properties.Domain);
    expect(prefixesOf(dev.data)).toHaveLength(1);
    expect(prefixesOf(prod.data)).toHaveLength(1);
    expect(prefixesOf(dev.data)[0]).not.toBe(prefixesOf(prod.data)[0]);
  });

  it("attaches the household trigger to both pools, not just the original", () => {
    // A replacement pool without it issues tokens with no household claim, and
    // the API refuses every one of them — which reads as a broken app.
    const pools = Object.values(dev.data.findResources("AWS::Cognito::UserPool"));
    for (const p of pools) {
      expect((p as any).Properties.LambdaConfig?.PreTokenGeneration).toBeDefined();
    }
  });

  it("maps email_verified from Google", () => {
    // Without this Cognito defaults it to false, the pre-token trigger refuses
    // the sign-in, and the user is told they have no household — which reads
    // as a broken app rather than a missing attribute.
    // Asserted against dev: prod has no Google client id configured yet, so no
    // provider resource exists there at all.
    dev.data.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", {
      AttributeMapping: Match.objectLike({ email_verified: "email_verified" }),
    });
  });

  it("makes the household claim immutable", () => {
    // A self-mutable attribute would let someone move themselves into another
    // household, which is the whole authorisation model.
    dev.data.hasResourceProperties("AWS::Cognito::UserPool", {
      Schema: Match.arrayWith([
        Match.objectLike({ Name: "tenant", Mutable: false }),
      ]),
    });
  });

  it("keeps the household claim immutable, which IS the access-control model", () => {
    // The opposite requirement, and the reason the one above needs explaining.
    // A user changing their own household would be a privilege escalation, and
    // Cognito makes custom attributes self-mutable by default.
    dev.data.hasResourceProperties("AWS::Cognito::UserPool", {
      Schema: Match.arrayWith([
        Match.objectLike({ Name: "tenant", Mutable: false }),
      ]),
    });
  });

  it("attaches the pre-token trigger that assigns the household", () => {
    dev.data.hasResourceProperties("AWS::Cognito::UserPool", {
      LambdaConfig: Match.objectLike({ PreTokenGeneration: Match.anyValue() }),
    });
  });
});
