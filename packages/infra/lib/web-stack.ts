import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import type { Identity } from "./data-stack.js";
import { Construct } from "constructs";
import * as path from "node:path";
import { config, type EnvSettings } from "./config.js";
import { fileURLToPath } from "node:url";

/** ESM has no `__dirname`; this is it. */
const here = path.dirname(fileURLToPath(import.meta.url));

export interface WebStackProps extends cdk.StackProps {
  readonly settings: EnvSettings;
  readonly identity: Identity;
  readonly apiUrl: string;
}

/**
 * The dashboard: a private bucket behind CloudFront.
 *
 * Entirely stateless — the bucket holds build output and nothing else, so this
 * stack can be destroyed and redeployed at will.
 *
 * Configuration is written as an object rather than compiled into the bundle,
 * so one build works in every environment. Baking it in would produce a dev
 * bundle and a prod bundle differing by three strings, and deploying the wrong
 * one points the dashboard at the wrong ledger without any visible sign.
 */
export class WebStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    const { settings, identity, apiUrl } = props;

    const bucket = new s3.Bucket(this, "Site", {
      // No public access at all: CloudFront reaches it through Origin Access
      // Control, so the bucket is never a second front door.
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    /**
     * Security headers.
     *
     * connect-src is the one that matters: it names exactly the hosts this app
     * may talk to. Injected script that tried to post a transaction description
     * anywhere else would be blocked by the browser.
     *
     * There are three, and the hosted UI is easy to miss because nothing
     * exercises it locally — `vite dev` serves no CSP at all, so a missing host
     * only fails once deployed. `auth.ts` fetches the hosted UI's
     * `/oauth2/token` to exchange the authorisation code, and without it here
     * Google sign-in completes at the provider and then dies silently in the
     * browser. The redirects to `/oauth2/authorize` and `/logout` are
     * navigations rather than fetches, so they are not governed by this.
     */
    const headers = new cloudfront.ResponseHeadersPolicy(this, "SecurityHeaders", {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          override: true,
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data:",
            `connect-src 'self' ${apiUrl} https://${identity.hostedUiDomain} https://cognito-idp.${this.region}.amazonaws.com`,
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'",
          ].join("; "),
        },
        strictTransportSecurity: {
          override: true,
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { override: true, frameOption: cloudfront.HeadersFrameOption.DENY },
        referrerPolicy: {
          override: true,
          referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
        },
      },
    });

    const distribution = new cloudfront.Distribution(this, "Cdn", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
      },
      defaultRootObject: "index.html",
      // Single-page app: unknown paths are routes, not missing files.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
      // Europe and North America only — this is a UK household application, and
      // the cheaper price class is the honest choice.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      comment: `${config.appName}-${settings.name} dashboard`,
      ...(settings.web
        ? {
            domainNames: [settings.web.domainName],
            certificate: acm.Certificate.fromCertificateArn(
              this,
              "SiteCertificate",
              settings.web.certificateArn,
            ),
          }
        : {}),
    });

    const sources = [
      s3deploy.Source.asset(path.join(here, "../../web/dist")),
      // Written by CDK, so it always matches the stack that deployed it.
      s3deploy.Source.jsonData("config.json", {
        userPoolId: identity.pool.userPoolId,
        userPoolClientId: identity.client.userPoolClientId,
        // From the same object as the pool, so the two cannot disagree.
        hostedUiDomain: identity.hostedUiDomain,
        apiUrl,
      }),
    ];

    /*
      Everything, cached hard. Asset filenames carry a content hash, so a given
      URL never changes what it returns and a year is safe.
    */
    const everything = new s3deploy.BucketDeployment(this, "Deploy", {
      sources,
      destinationBucket: bucket,
      distribution,
      distributionPaths: ["/*"],
      prune: true,
      cacheControl: [s3deploy.CacheControl.maxAge(cdk.Duration.days(365)), s3deploy.CacheControl.immutable()],
    });

    /*
      Then the two files that must never be cached, written over the top.

      `index.html` names the hashed bundle and `config.json` carries the pool and
      API this build talks to — both change every deploy while keeping their
      names. Under the headers above a browser holds the old ones and loads a
      previous build from a fresh bucket, which reads as "the deploy did
      nothing": the invalidation clears CloudFront, and nothing clears the
      browser.

      `prune: false` because these files are already in the deployment above and
      pruning here would delete everything else.
    */
    new s3deploy.BucketDeployment(this, "DeployUncached", {
      sources,
      destinationBucket: bucket,
      distribution,
      distributionPaths: ["/", "/index.html", "/config.json"],
      include: ["index.html", "config.json"],
      prune: false,
      cacheControl: [s3deploy.CacheControl.noCache(), s3deploy.CacheControl.mustRevalidate()],
    }).node.addDependency(everything);

    new cdk.CfnOutput(this, "SiteUrl", { value: `https://${distribution.distributionDomainName}` });

    cdk.Tags.of(this).add("app", config.appName);
    cdk.Tags.of(this).add("env", settings.name);
    cdk.Tags.of(this).add("tier", "stateless");
  }
}
