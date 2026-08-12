import { describe, it, expect } from "vitest";
import { Match } from "aws-cdk-lib/assertions";
import { templates } from "./harness";

const { api, web } = templates();

describe("api", () => {
  it("puts a JWT authoriser on every route", () => {
    // The household comes from a verified claim and never from the request. A
    // route added without an authoriser is an unauthenticated read of somebody
    // else's ledger, which is the one failure this design cannot tolerate.
    const routes = api.findResources("AWS::ApiGatewayV2::Route");
    expect(Object.keys(routes).length).toBeGreaterThan(0);
    for (const [id, r] of Object.entries(routes)) {
      const props = (r as any).Properties;
      expect(props.AuthorizationType, `route ${id} (${props.RouteKey})`).toBe("JWT");
      expect(props.AuthorizerId, `route ${id} (${props.RouteKey})`).toBeDefined();
    }
  });

  it("serves the routes the dashboard and connect flow need", () => {
    const keys = Object.values(api.findResources("AWS::ApiGatewayV2::Route"))
      .map((r: any) => r.Properties.RouteKey)
      .sort();
    expect(keys).toEqual([
      "GET /accounts",
      "GET /connect/callback",
      "GET /connect/start",
      "GET /summary",
      "GET /transactions",
    ]);
  });

  it("trusts only this user pool", () => {
    api.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      AuthorizerType: "JWT",
      JwtConfiguration: Match.objectLike({ Audience: Match.anyValue() }),
    });
  });
});

describe("web", () => {
  it("keeps the bucket private and reaches it through an origin access control", () => {
    // The dashboard bucket must not be a website endpoint: that would serve
    // the app publicly and bypass CloudFront entirely.
    web.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true }),
    });
    expect(Object.keys(web.findResources("AWS::CloudFront::OriginAccessControl")).length).toBe(1);
  });

  it("sends unknown paths to the app rather than an error", () => {
    // A single-page app owns its own routing; /connected must reach index.html
    // or the bank redirect lands on a CloudFront 404.
    const dists = web.findResources("AWS::CloudFront::Distribution");
    const responses = Object.values(dists)
      .flatMap((d: any) => d.Properties?.DistributionConfig?.CustomErrorResponses ?? []);
    expect(responses.some((r: any) => r.ResponseCode === 200 && r.ResponsePagePath === "/index.html")).toBe(true);
  });

  it("serves over HTTPS only", () => {
    web.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: Match.stringLikeRegexp("redirect-to-https|https-only"),
        }),
      }),
    });
  });
});
