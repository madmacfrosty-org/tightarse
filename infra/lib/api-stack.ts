import * as cdk from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type { Identity } from "./data-stack.js";
import { CONNECT_PATHS, ROUTES, pathFor } from "@tightarse/api-contract";
import { Construct } from "constructs";
import * as path from "node:path";
import { config, type EnvSettings } from "./config";

export interface ApiStackProps extends cdk.StackProps {
  readonly settings: EnvSettings;
  readonly table: dynamodb.TableV2;
  readonly identity: Identity;
  /**
   * Name of the connect function, which lives in IngestStack.
   *
   * Passed as a NAME rather than the construct, and resolved with
   * `fromFunctionName`. Importing the object would make this stack depend on
   * IngestStack while IngestStack already depends on the bucket and table in
   * DataStack — the same cycle that forced EventBridge on the transform.
   */
  readonly connectFunctionName?: string;
}

/**
 * The aggregation API, behind Cognito.
 *
 * Stateless: destroy and redeploy freely. Nothing here holds data.
 *
 * Authorisation is a JWT authoriser at the gateway, so an unauthenticated
 * request never reaches the Lambda and never costs an invocation. The handler
 * then reads the household from the verified `custom:tenant` claim — never from
 * the request — which is the whole access-control model: without it, any
 * authenticated user could read any household's ledger by changing a query
 * parameter.
 */
export class ApiStack extends cdk.Stack {
  public readonly api: apigw.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { settings, table, identity } = props;

    const handler = new NodejsFunction(this, "ApiHandler", {
      entry: path.join(__dirname, "../../services/api/src/handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(15),
      environment: {
        TABLE_NAME: table.tableName,
        // Never log a transaction body; descriptions are the sensitive part.
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: { minify: true, sourceMap: true, target: "node22" },
      logGroup: new logs.LogGroup(this, "ApiHandlerLogs", {
        retention: settings.name === "prod" ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Read only. The API has no reason to write, and a bug that could mutate
    // the ledger from a GET is worth making impossible rather than unlikely.
    table.grantReadData(handler);

    // The issuer Cognito stamps into every token it mints.
    const issuer = `https://cognito-idp.${cdk.Stack.of(this).region}.amazonaws.com/${identity.pool.userPoolId}`;

    const authorizer = new authorizers.HttpJwtAuthorizer("CognitoAuthorizer", issuer, {
      jwtAudience: [identity.client.userPoolClientId],
      identitySource: ["$request.header.Authorization"],
    });

    this.api = new apigw.HttpApi(this, "HttpApi", {
      apiName: `${config.appName}-${settings.name}`,
      // The dashboard is served from a different origin, so it needs CORS —
      // but only for the origins we actually serve it from.
      corsPreflight: {
        // The CloudFront domain is not known when this stack is synthesised —
        // WebStack depends on this one — so it is supplied as context after the
        // first deploy. Until then the dashboard works from a local dev server.
        allowOrigins: [
          ...(scope.node.tryGetContext("siteOrigin")
            ? [String(scope.node.tryGetContext("siteOrigin"))]
            : []),
          ...(settings.name === "prod" ? [] : ["http://localhost:5173", "http://127.0.0.1:5173"]),
        ],
        allowMethods: [apigw.CorsHttpMethod.GET],
        allowHeaders: ["authorization", "content-type"],
        maxAge: cdk.Duration.hours(1),
      },
      // No default route and no default integration: an unknown path is
      // rejected by the gateway rather than reaching the Lambda. Every route is
      // declared and authorised explicitly, so there is no public surface.
      defaultAuthorizer: authorizer,
    });

    // Paths come from the contract package, so the gateway, the dashboard and
    // the published OpenAPI document cannot disagree about what is served. A
    // route added to one and forgotten in another is either a 404 or an
    // undocumented endpoint, and both are silent. See #27.
    for (const route of ROUTES.map((r) => pathFor(r))) {
      this.api.addRoutes({
        path: route,
        methods: [apigw.HttpMethod.GET],
        integration: new integrations.HttpLambdaIntegration(
          `Int${route.replace(/[^a-zA-Z0-9]/g, "")}`,
          handler,
        ),
        authorizer,
      });
    }

    // Connect routes, authorised identically. Starting a bank connection is a
    // write to somebody's household, so it needs the same claim the reads do.
    if (props.connectFunctionName) {
      const connect = lambda.Function.fromFunctionName(this, "ConnectFn", props.connectFunctionName);
      for (const route of CONNECT_PATHS.map((p) => pathFor(p))) {
        this.api.addRoutes({
          path: route,
          methods: [apigw.HttpMethod.GET],
          integration: new integrations.HttpLambdaIntegration(
            `Int${route.replace(/[^a-zA-Z0-9]/g, "")}`,
            connect,
          ),
          authorizer,
        });
      }
    }

    new cdk.CfnOutput(this, "ApiUrl", { value: this.api.apiEndpoint });

    cdk.Tags.of(this).add("app", config.appName);
    cdk.Tags.of(this).add("env", settings.name);
    cdk.Tags.of(this).add("tier", "stateless");
  }
}
