#!/usr/bin/env node
// Note: infra/tsconfig.json disables exactOptionalPropertyTypes. CDK's
// interfaces declare optional members that its own concrete classes leave
// undefined, so the flag rejects code the library intends. Only this project
// relaxes it; everything that touches ledger data keeps it on.
import * as cdk from "aws-cdk-lib";
import { config, envSettings } from "../lib/config";
import { FoundationStack } from "../lib/foundation-stack";
import { DataStack } from "../lib/data-stack";
import { ApiStack } from "../lib/api-stack";
import { WebStack } from "../lib/web-stack";

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
});

const api = new ApiStack(app, `TightarseApi-${settings.name}`, {
  env,
  settings,
  table: data.table,
  userPool: data.userPool,
  userPoolClient: data.userPoolClient,
});

new WebStack(app, `TightarseWeb-${settings.name}`, {
  env,
  settings,
  userPool: data.userPool,
  userPoolClient: data.userPoolClient,
  apiUrl: api.api.apiEndpoint,
});

// Stateless stacks (ingest, transform, api, web, agents) are added as they are
// built — see the open issues.

app.synth();
