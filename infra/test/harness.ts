import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { envSettings, config } from "../lib/config";
import { FoundationStack } from "../lib/foundation-stack";
import { DataStack } from "../lib/data-stack";
import { ApiStack } from "../lib/api-stack";
import { IngestStack } from "../lib/ingest-stack";
import { WebStack } from "../lib/web-stack";

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

export function buildApp(
  context: Record<string, unknown> = {},
): Stacks {
  const app = new cdk.App({
    context: {
      // Skip esbuild for every stack.
      "aws:cdk:bundling-stacks": [],
      ...context,
    },
  });
  const settings = envSettings(app);
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
    userPool: data.userPool,
    userPoolClient: data.userPoolClient,
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
    alertEmail: "alerts@example.com",
  });
  const web = new WebStack(app, `TightarseWeb-${settings.name}`, {
    env,
    settings,
    userPool: data.userPool,
    userPoolClient: data.userPoolClient,
    apiUrl: api.api.apiEndpoint,
  });

  return { app, foundation, data, api, ingest, web };
}

export function templates(context: Record<string, unknown> = {}) {
  const s = buildApp(context);
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
