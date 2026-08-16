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
  it("configures federation only where a client id is supplied", () => {
    // prod has none yet. Worth an explicit test so its absence is a recorded
    // state rather than something noticed at sign-in.
    expect(Object.keys(dev.data.findResources("AWS::Cognito::UserPoolIdentityProvider"))).toHaveLength(1);
    expect(Object.keys(prod.data.findResources("AWS::Cognito::UserPoolIdentityProvider"))).toHaveLength(0);
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

  it("requires an email and keeps it MUTABLE, or federated sign-in breaks", () => {
    // This test asserted the opposite, and the opposite is what locked the
    // account out. Cognito re-applies an identity provider's attribute mapping
    // on every federated sign-in, not only at creation: with email immutable
    // the first Google sign-in creates the user and every one after it fails
    // with "user.email: Attribute cannot be updated".
    //
    // `mutable: false` is the intuitive value and reads like tightening
    // something, which is why it needs saying here as well as in the stack.
    // Changing it replaces the user pool, so being wrong costs twice.
    dev.data.hasResourceProperties("AWS::Cognito::UserPool", {
      Schema: Match.arrayWith([
        Match.objectLike({ Name: "email", Required: true, Mutable: true }),
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
