#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { config, envSettings } from "../lib/config";
import { DataStack } from "../lib/data-stack";

const app = new cdk.App();
const settings = envSettings(app);

// Account is left unresolved when CDK_DEFAULT_ACCOUNT is unset, so synth works
// without credentials; deploy resolves it from the ambient profile.
const account = process.env.CDK_DEFAULT_ACCOUNT;
const env: cdk.Environment = account
  ? { account, region: config.region }
  : { region: config.region };

// Stack names carry the environment so a dev and prod stack can never be
// confused in the console, and so `cdk deploy` without `-c env=prod` cannot
// silently target the wrong one.
new DataStack(app, `TightarseData-${settings.name}`, { env, settings });

// Stateless stacks (ingest, transform, api, web, agents) are added as they are
// built — see the open issues. They may be destroyed and redeployed freely;
// only DataStack holds anything that cannot be recreated from this repo.

app.synth();
