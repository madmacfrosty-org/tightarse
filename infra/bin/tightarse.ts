#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { config } from "../lib/config";
import { LedgerStack } from "../lib/ledger-stack";

const app = new cdk.App();

// Account is left unresolved when CDK_DEFAULT_ACCOUNT is unset, so synth works
// without credentials; deploy resolves it from the ambient profile.
const account = process.env.CDK_DEFAULT_ACCOUNT;
const env: cdk.Environment = account
  ? { account, region: config.region }
  : { region: config.region };

new LedgerStack(app, "TightarseLedger", { env });

// Further stacks (ingest, api, web, agents) are added as they are built —
// see the open issues.

app.synth();
