import { describe, it, expect } from "vitest";
import { Match } from "aws-cdk-lib/assertions";
import { templates } from "./harness";

const { api, web, stacks } = templates();

describe("api", () => {
  it("authorises every route, with nothing left open", () => {
    // A route added without an authoriser is an unauthenticated read of
    // somebody else's ledger, which is the one failure this design cannot
    // tolerate.
    const routes = api.findResources("AWS::ApiGatewayV2::Route");
    expect(Object.keys(routes).length).toBeGreaterThan(0);
    for (const [id, r] of Object.entries(routes)) {
      const props = (r as any).Properties;
      expect(props.AuthorizationType, `route ${id} (${props.RouteKey})`).toBe("JWT");
      expect(props.AuthorizerId, `route ${id} (${props.RouteKey})`).toBeDefined();
    }
  });

  it("puts every route behind Cognito, including the ones that write", () => {
    // Spelled out per route rather than counted. These were signed with SigV4
    // and resolved the household from the environment, which left the dashboard
    // unable to call its own API. One authoriser now, and one place the
    // household is resolved.
    const byKey = Object.fromEntries(
      Object.values(api.findResources("AWS::ApiGatewayV2::Route")).map((r: any) => [
        r.Properties.RouteKey,
        r.Properties.AuthorizationType,
      ]),
    );

    expect(byKey["GET /v1/summary"]).toBe("JWT");
    expect(byKey["GET /v1/transactions"]).toBe("JWT");
    expect(byKey["GET /v1/accounts"]).toBe("JWT");
    expect(byKey["GET /v1/balances"]).toBe("JWT");
    expect(byKey["GET /v1/connect/start"]).toBe("JWT");
    expect(byKey["GET /v1/connect/callback"]).toBe("JWT");
    expect(byKey["GET /v1/categorisation/gaps"]).toBe("JWT");
    expect(byKey["POST /v1/categorisation/proposals"]).toBe("JWT");
  });

  /** DynamoDB actions granted to whichever role a named function runs as. */
  const dynamoActionsFor = (prefix: string): string[] => {
    const fns = api.findResources("AWS::Lambda::Function");
    const [id] = Object.keys(fns).filter((i) => i.startsWith(prefix));
    expect(id, `no function named ${prefix}`).toBeDefined();

    const role = (fns[id!] as any).Properties.Role["Fn::GetAtt"][0];
    return Object.values(api.findResources("AWS::IAM::Policy"))
      .filter((p: any) => (p.Properties.Roles ?? []).some((r: any) => r.Ref === role))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
      .flatMap((st: any) => (Array.isArray(st.Action) ? st.Action : [st.Action]))
      .filter((a: unknown): a is string => typeof a === "string" && a.startsWith("dynamodb:"));
  };

  it("keeps the dashboard's function read-only, whatever the other one may do", () => {
    // The reason these are two functions. A mutation path behind every GET the
    // browser makes is the thing this arrangement exists to prevent, and it is
    // asserted per role rather than across the template — a template-wide check
    // passes the moment any function is allowed to write.
    for (const action of dynamoActionsFor("ApiHandler")) {
      expect(action, `the dashboard's function may ${action}`).not.toMatch(/Put|Update|Delete|Write/);
    }
  });

  it("lets the categorisation function write, because proposals are a write", () => {
    const actions = dynamoActionsFor("CategorisationHandler");

    expect(actions.some((a) => /Put|Update/.test(a)), "cannot write a proposal").toBe(true);
    // What keeps this narrow is the handler, not IAM: there is no route that
    // makes a version effective, and accepting is not reachable from a signed
    // request at all.
    expect(actions.some((a) => /GetItem|Query/.test(a)), "cannot read").toBe(true);
  });

  it("gives the categorisation handler its own function, with no household of its own", () => {
    // It resolves the household from the verified claim like everything else.
    // A TENANT_ID here would be a second answer to the same question, and the
    // wrong one the moment a token says otherwise.
    const fns = api.findResources("AWS::Lambda::Function");
    const ids = Object.keys(fns).filter((i) => i.startsWith("CategorisationHandler"));

    expect(ids).toHaveLength(1);
    expect((fns[ids[0]!] as any).Properties.Environment.Variables.TENANT_ID).toBeUndefined();
  });

  it("allows the browser to POST, since proposing a rule is a write it makes", () => {
    const [cors] = Object.values(api.findResources("AWS::ApiGatewayV2::Api")).map(
      (a: any) => a.Properties.CorsConfiguration,
    );

    expect(cors.AllowMethods).toContain("POST");
    expect(cors.AllowMethods).toContain("GET");
  });

  it("is deployed after ingest, which owns the function it imports by name", () => {
    // The connect function is imported with fromFunctionName, so the template
    // carries no reference to IngestStack and CDK would otherwise be free to
    // deploy this stack first. Against an empty account that means creating a
    // Lambda permission for a function that does not exist yet: CloudFormation
    // returns 404 and rolls the stack back, which is how prod's first deploy
    // failed. An account where the function already exists cannot show this,
    // which is why dev never did.
    const names = stacks.api.dependencies.map((d) => d.stackName);
    expect(names).toContain(stacks.ingest.stackName);
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
      "GET /v1/categorisation/gaps",
      "GET /v1/connect/callback",
      "GET /v1/connect/start",
      "GET /v1/summary",
      "GET /v1/transactions",
      "POST /v1/categorisation/proposals",
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
      expect(key, `${key} is not versioned`).toMatch(/^(GET|POST) \/v1\//);
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
