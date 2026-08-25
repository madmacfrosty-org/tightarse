import * as cdk from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type { Identity } from "./data-stack.js";
import { CATEGORISATION_ROUTES, CONNECT_PATHS, ROUTES, pathFor } from "@tightarse/api-contract";
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
        // The site URL is also its origin — scheme and host, no path — so this
        // reuses the one in settings rather than taking a separate context
        // value. It used to read `siteOrigin` from CDK context, which nothing
        // set: the deployed dashboard's preflight came back without an
        // `access-control-allow-origin` header and every request failed as
        // "Failed to fetch", while localhost worked perfectly.
        //
        // Context is the wrong home for this. It is not persisted, so even when
        // supplied once by hand the next deploy drops it — the same trap as the
        // callback URL and the bank redirect.
        allowOrigins: [
          ...(settings.siteUrl ? [settings.siteUrl] : []),
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

    // Categorisation, behind SigV4 rather than the Cognito authoriser.
    //
    // A separate function on purpose. The household comes from the environment
    // here, because a signed request carries an AWS principal and no household
    // claim — and a single handler holding both models would be one mistake
    // away from honouring an environment tenant on a bearer-token route.
    //
    // The caller is an AWS principal in this account, which can already read
    // the table directly. So this grants no access that did not exist; what it
    // adds is a surface that speaks the application's language rather than
    // DynamoDB's, which is the surface the dashboard will eventually need too.
    const categorisation = new NodejsFunction(this, "CategorisationHandler", {
      entry: path.join(__dirname, "../../services/api/src/categorisation.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      // 512 is the account's ceiling, not a tuning choice. This account's
      // Lambda memory quota is capped there, so 1024 synthesises perfectly and
      // is rejected at deploy time with the stack rolled back — which is
      // exactly how it was found. Guarded by a test now.
      memorySize: 512,
      // It reads the whole ledger and evaluates every rule against every
      // transaction, twice over. Seconds, not milliseconds, and deliberately
      // so: nothing is cached, because a stale reach figure in front of someone
      // approving a rule is worse than a slow one. Memory also buys CPU share,
      // so this is set for the slower end of that.
      timeout: cdk.Duration.seconds(60),
      environment: {
        TABLE_NAME: table.tableName,
        // Fixed at deploy time, exactly as the scheduled categoriser has it. A
        // caller cannot ask for a different household because it is not a thing
        // the request can say.
        TENANT_ID: "frost",
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: { minify: true, sourceMap: true, target: "node22" },
      logGroup: new logs.LogGroup(this, "CategorisationHandlerLogs", {
        retention: settings.name === "prod" ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Read only, still. Proposals will need to write, and that grant arrives
    // with them rather than ahead of them.
    table.grantReadData(categorisation);

    const signed = new authorizers.HttpIamAuthorizer();

    for (const route of CATEGORISATION_ROUTES.map((r) => pathFor(r))) {
      this.api.addRoutes({
        path: route,
        methods: [apigw.HttpMethod.GET],
        integration: new integrations.HttpLambdaIntegration(
          `Int${route.replace(/[^a-zA-Z0-9]/g, "")}`,
          categorisation,
        ),
        // Overrides the API's default Cognito authoriser for these routes only.
        authorizer: signed,
      });
    }

    new cdk.CfnOutput(this, "ApiUrl", { value: this.api.apiEndpoint });

    cdk.Tags.of(this).add("app", config.appName);
    cdk.Tags.of(this).add("env", settings.name);
    cdk.Tags.of(this).add("tier", "stateless");
  }
}
