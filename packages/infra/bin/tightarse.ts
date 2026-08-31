#!/usr/bin/env node
// Note: infra/tsconfig.json disables exactOptionalPropertyTypes. CDK's
// interfaces declare optional members that its own concrete classes leave
// undefined, so the flag rejects code the library intends. Only this project
// relaxes it; everything that touches ledger data keeps it on.
import * as cdk from "aws-cdk-lib";
import { config, envSettings } from "../lib/config.js";
import { FoundationStack } from "../lib/foundation-stack.js";
import { DataStack } from "../lib/data-stack.js";
import { ApiStack } from "../lib/api-stack.js";
import { WebStack } from "../lib/web-stack.js";
import { IngestStack } from "../lib/ingest-stack.js";

const app = new cdk.App();
const settings = envSettings(app);

// Account is left unresolved when CDK_DEFAULT_ACCOUNT is unset, so synth works
// without credentials; deploy resolves it from the ambient profile.
const account = process.env.CDK_DEFAULT_ACCOUNT;
const env: cdk.Environment = account
  ? { account, region: config.region }
  : { region: config.region };

// Three tiers, by how survivable each is.
//
//   Foundation  never destroyed, in any environment
//   Data        destroyable in dev, retained in prod
//   Stateless   destroyed and redeployed freely
//
// Stack names carry the environment so dev and prod can never be confused in
// the console, and so `cdk deploy` without `-c env=prod` cannot silently
// target the wrong one.
const foundation = new FoundationStack(app, `TightarseFoundation-${settings.name}`, { env, settings });

const data = new DataStack(app, `TightarseData-${settings.name}`, {
  env,
  settings,
  dataKey: foundation.dataKey,
  googleOAuthSecret: foundation.googleOAuthSecret,
});

// The connect function's name is fixed rather than generated, so ApiStack can
// reference it without importing the construct — which would create a cycle,
// since IngestStack already depends on DataStack.
const connectFunctionName = `tightarse-${settings.name}-connect`;

const api = new ApiStack(app, `TightarseApi-${settings.name}`, {
  env,
  settings,
  table: data.table,
  // #36: the replacement pool. The original has an immutable `email`, which
  // makes every federated sign-in after the first one fail. One word to revert.
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

// Passing the connect function by name tells CloudFormation nothing: no resource
// in the Api template refers to the Ingest template, so CDK is free to deploy Api
// first. Where the function already exists that is harmless, which is why dev
// never showed it — dev grew Ingest before Api. In an empty account the Lambda
// permission is created against a function that is not there yet, CloudFormation
// returns 404, and the whole stack rolls back. That is prod's first deploy.
//
// This is not the cycle the name-passing avoids. That cycle would need Ingest to
// reference something in Api, and it references nothing: a stack dependency
// orders the deploy without putting an export between the two.
api.addStackDependency(ingest);

new WebStack(app, `TightarseWeb-${settings.name}`, {
  env,
  settings,
  // #36: the replacement pool. The original has an immutable `email`, which
  // makes every federated sign-in after the first one fail. One word to revert.
  identity: data.identityV2,
  apiUrl: api.api.apiEndpoint,
});

// Stateless stacks (ingest, transform, api, web, agents) are added as they are
// built — see the open issues.

app.synth();
