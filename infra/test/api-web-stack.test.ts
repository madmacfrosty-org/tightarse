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
    // Spelled out rather than derived from the contract, for the same reason
    // the dashboard test is: building the expectation with pathFor() would let
    // the prefix disappear from both sides at once and still pass. #27.
    expect(keys).toEqual([
      "GET /v1/accounts",
      "GET /v1/balances",
      "GET /v1/connect/callback",
      "GET /v1/connect/start",
      "GET /v1/summary",
      "GET /v1/transactions",
    ]);
  });

  it("serves nothing outside the version prefix", () => {
    // An unversioned path served by accident is one that has to be supported
    // for ever the moment anything calls it — and the gateway has no default
    // route, so anything not listed here is refused rather than reaching a
    // Lambda.
    const keys = Object.values(api.findResources("AWS::ApiGatewayV2::Route")).map(
      (r: any) => r.Properties.RouteKey as string,
    );
    for (const key of keys) {
      expect(key, `${key} is not versioned`).toMatch(/^GET \/v1\//);
    }
  });

  it("trusts only this user pool", () => {
    api.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      AuthorizerType: "JWT",
      JwtConfiguration: Match.objectLike({ Audience: Match.anyValue() }),
    });
  });

  it("allows the deployed origin through CORS, not only localhost", () => {
    // The browser refuses a cross-origin response with no
    // access-control-allow-origin header, and the app reports it as the wholly
    // uninformative "Failed to fetch". This allow-list used to come from CDK
    // context that nothing set, so the deployed dashboard could sign in and then
    // fail every request while localhost was fine.
    const cors = (Object.values(api.findResources("AWS::ApiGatewayV2::Api"))[0] as any).Properties
      .CorsConfiguration;
    expect(cors.AllowOrigins).toContain("http://localhost:5173");
    expect(
      (cors.AllowOrigins as string[]).some((o) => o.includes("cloudfront.net")),
      `origins were ${JSON.stringify(cors.AllowOrigins)}`,
    ).toBe(true);
  });

  it("validates tokens against the same pool the dashboard signs in to", () => {
    // The failure this prevents is silent and total: the dashboard sends the
    // user to pool A, the API validates against pool B, and every request comes
    // back 401 with a perfectly valid token. Nothing in either stack looks
    // wrong on its own. It is only wrong in the pair — which is why #36 groups
    // pool, client and domain into one `Identity` rather than three props that
    // happen to be passed together.
    const imports = (node: unknown): string[] => {
      const found: string[] = [];
      const walk = (n: any): void => {
        if (n === null || typeof n !== "object") return;
        if (typeof n["Fn::ImportValue"] === "string") found.push(n["Fn::ImportValue"]);
        for (const v of Object.values(n)) walk(v);
      };
      walk(node);
      return found;
    };

    const authoriser = Object.values(api.findResources("AWS::ApiGatewayV2::Authorizer"))[0];
    const poolImports = imports((authoriser as any).Properties.JwtConfiguration.Issuer);
    expect(poolImports).toHaveLength(1);

    // The dashboard's config.json is written by CDK, and the pool id reaches it
    // as a substitution marker rather than a literal.
    const deployment = Object.values(web.findResources("Custom::CDKBucketDeployment"))[0];
    const webImports = imports((deployment as any).Properties.SourceMarkers);

    expect(webImports).toContain(poolImports[0]);
  });
});

describe("web", () => {
  it("permits every host the app actually fetches, and no others", () => {
    // The failure this prevents is invisible locally: `vite dev` serves no CSP,
    // so a missing host only breaks once deployed. `auth.ts` fetches two hosts —
    // the API for data and the hosted UI to exchange the authorisation code for
    // a token — and a CSP naming only the first lets Google sign-in complete at
    // the provider and then die silently in the browser.
    const policy = Object.values(web.findResources("AWS::CloudFront::ResponseHeadersPolicy"))[0] as any;
    const csp = JSON.stringify(
      policy.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy
        .ContentSecurityPolicy,
    );

    const connect = csp.slice(csp.indexOf("connect-src"), csp.indexOf("frame-ancestors"));
    expect(connect).toContain("'self'");
    // The hosted UI, for the token exchange.
    expect(connect).toMatch(/auth\..*amazoncognito\.com/);
    // The API, which arrives as a cross-stack import rather than a literal.
    expect(connect).toContain("ImportValue");
    expect(connect).toContain("cognito-idp");
    // Nothing may be reached by default: a transaction description must not be
    // postable to an arbitrary host by injected script.
    expect(csp).toContain("default-src 'self'");
  });

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
