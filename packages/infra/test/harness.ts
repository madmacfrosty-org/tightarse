import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { envSettings, config, type EnvSettings } from "../lib/config.js";
import { FoundationStack } from "../lib/foundation-stack.js";
import { DataStack } from "../lib/data-stack.js";
import { ApiStack } from "../lib/api-stack.js";
import { IngestStack } from "../lib/ingest-stack.js";
import { WebStack } from "../lib/web-stack.js";

/**
 * Synthesise the real application, exactly as bin/tightarse.ts wires it.
 *
 * Assertions run against the synthesised template rather than the constructs,
 * because the template is what CloudFormation acts on — and every incident this
 * project has had was something that synthesised perfectly and then failed at
 * deploy or at runtime.
 *
 * Bundling is disabled. esbuild runs once per Lambda otherwise, which turns a
 * fast suite into a slow one and tests nothing: the handler code has its own
 * tests, and what is under test here is the infrastructure around it.
 */
export interface Stacks {
  app: cdk.App;
  foundation: cdk.Stack;
  data: cdk.Stack;
  api: cdk.Stack;
  ingest: cdk.Stack;
  web: cdk.Stack;
}

/**
 * WebStack deploys web/dist as a bucket asset, and CDK resolves assets during
 * synthesis whether or not bundling is skipped — so without this the infra
 * tests fail wherever the dashboard has not been built. They passed locally
 * only because a previous build had left dist behind, which made them depend on
 * a build artefact without saying so.
 *
 * The content is irrelevant: what is under test is the infrastructure around
 * the asset, not the asset.
 */
function ensureWebDist(): void {
  const dist = path.join(fileURLToPath(new URL("../../web", import.meta.url)), "dist");
  if (existsSync(path.join(dist, "index.html"))) return;
  mkdirSync(dist, { recursive: true });
  writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>test</title>");
}

/**
 * Build every stack for one environment.
 *
 * `override` exists so a test can synthesise a state no named environment is in.
 * Both dev and prod now have a site, which left the "no site yet" branches —
 * the Cognito callback list and the bank redirect — exercised by nothing. They
 * had been covered incidentally, because prod happened to lack a domain, and the
 * day prod got one they went quiet without any test failing to say so.
 *
 * An environment's incidental configuration is not a fixture. This makes the
 * state explicit instead.
 */
export function buildApp(
  context: Record<string, unknown> = {},
  override: Partial<EnvSettings> = {},
): Stacks {
  ensureWebDist();
  const app = new cdk.App({
    context: {
      // Skip esbuild for every stack.
      "aws:cdk:bundling-stacks": [],
      ...context,
    },
  });
  const settings: EnvSettings = { ...envSettings(app), ...override };
  const env = { account: "111122223333", region: config.region };

  const foundation = new FoundationStack(app, `TightarseFoundation-${settings.name}`, {
    env,
    settings,
  });
  const data = new DataStack(app, `TightarseData-${settings.name}`, {
    env,
    settings,
    dataKey: foundation.dataKey,
    googleOAuthSecret: foundation.googleOAuthSecret,
  });
  const connectFunctionName = `tightarse-${settings.name}-connect`;
  const api = new ApiStack(app, `TightarseApi-${settings.name}`, {
    env,
    settings,
    table: data.table,
    // Must match bin/tightarse.ts. A harness pinned to a different pool would
    // test a stack nobody deploys.
    identity: data.identityV2,
    connectFunctionName,
  });
  const ingest = new IngestStack(app, `TightarseIngest-${settings.name}`, {
    env,
    settings,
    connectFunctionName,
    rawBucket: data.rawBucket,
    table: data.table,
    dataKey: foundation.dataKey,
    clientSecret: foundation.clientSecret,
  });
  // Must match bin/tightarse.ts. The connect function crosses the two stacks as
  // a name, so only this makes CDK deploy Ingest first.
  api.addStackDependency(ingest);
  const web = new WebStack(app, `TightarseWeb-${settings.name}`, {
    env,
    settings,
    identity: data.identityV2,
    apiUrl: api.api.apiEndpoint,
  });

  return { app, foundation, data, api, ingest, web };
}

export function templates(
  context: Record<string, unknown> = {},
  override: Partial<EnvSettings> = {},
) {
  const s = buildApp(context, override);
  return {
    stacks: s,
    foundation: Template.fromStack(s.foundation),
    data: Template.fromStack(s.data),
    api: Template.fromStack(s.api),
    ingest: Template.fromStack(s.ingest),
    web: Template.fromStack(s.web),
  };
}

/** Every IAM policy statement in a template, flattened. */
export function policyStatements(t: Template): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const res of Object.values(t.findResources("AWS::IAM::Policy"))) {
    const doc = (res as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } })
      .Properties?.PolicyDocument?.Statement;
    for (const s of doc ?? []) out.push(s as Record<string, unknown>);
  }
  for (const res of Object.values(t.findResources("AWS::IAM::Role"))) {
    const doc = (res as { Properties?: { Policies?: Array<{ PolicyDocument?: { Statement?: unknown[] } }> } })
      .Properties?.Policies;
    for (const p of doc ?? []) for (const s of p.PolicyDocument?.Statement ?? []) {
      out.push(s as Record<string, unknown>);
    }
  }
  return out;
}
