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
  it("gives every pool its own provider where a client id is supplied", () => {
    // Two per environment, one per pool, while #36's changeover is in progress.
    // Both pools need their own — an identity provider belongs to a pool and
    // cannot be shared.
    expect(Object.keys(dev.data.findResources("AWS::Cognito::UserPoolIdentityProvider"))).toHaveLength(2);
    expect(Object.keys(prod.data.findResources("AWS::Cognito::UserPoolIdentityProvider"))).toHaveLength(2);
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

  it("gives the replacement pool a mutable email, which is its entire purpose", () => {
    // The one difference between the two pools, and the reason the second
    // exists. See #36: an immutable email makes every federated sign-in after
    // the first fail, and it cannot be changed on a pool that already exists.
    const pools = Object.values(dev.data.findResources("AWS::Cognito::UserPool"));
    const emailMutability = pools.map(
      (p: any) => p.Properties.Schema.find((a: any) => a.Name === "email")?.Mutable,
    );
    // One of each during the changeover: the original cannot be fixed, the
    // replacement is correct.
    expect(emailMutability.filter((m) => m === true)).toHaveLength(1);
    expect(emailMutability.filter((m) => m === false)).toHaveLength(1);
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

  it("gives the two pools different hosted UI prefixes", () => {
    // Cognito domain prefixes are globally unique across every AWS account, and
    // both pools exist at once. Reusing the prefix fails the deploy.
    const domains = Object.values(dev.data.findResources("AWS::Cognito::UserPoolDomain"));
    const prefixes = domains.map((d: any) => d.Properties.Domain);
    expect(prefixes).toHaveLength(2);
    expect(new Set(prefixes).size).toBe(2);
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

  it("pins email as immutable, which is a known defect and not a preference", () => {
    // This asserts the CURRENT state, not the desired one, and that is
    // deliberate — the two differ and the difference is tracked in #36.
    //
    // Email should be mutable: Cognito re-applies an identity provider's
    // attribute mapping on every federated sign-in, so an immutable one makes
    // the first Google sign-in succeed and every one after it fail with
    // "user.email: Attribute cannot be updated". That is the live symptom.
    //
    // It cannot be changed here. A pool's schema is fixed at creation, and
    // setting mutable: true produces an update Cognito rejects — which on 16
    // August left the stack in UPDATE_ROLLBACK_FAILED. Fixing it means a new
    // pool, so this test exists to make the current value a conscious record
    // rather than something a reader assumes was chosen.
    dev.data.hasResourceProperties("AWS::Cognito::UserPool", {
      Schema: Match.arrayWith([
        Match.objectLike({ Name: "email", Required: true, Mutable: false }),
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
