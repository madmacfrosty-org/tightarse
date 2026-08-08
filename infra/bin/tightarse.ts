#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { config } from "../lib/config";
import { LedgerStack } from "../lib/ledger-stack";

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: config.region,
};

new LedgerStack(app, "TightarseLedger", { env });

// Further stacks (ingest, api, web, agents) are added as they are built —
// see the open issues.

app.synth();
