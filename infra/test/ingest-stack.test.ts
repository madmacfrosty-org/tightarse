import { describe, it, expect } from "vitest";
import { Match } from "aws-cdk-lib/assertions";
import { templates, policyStatements } from "./harness";
import { connectRedirectUri, envSettings } from "../lib/config";
import * as cdk from "aws-cdk-lib";

const { ingest } = templates();
// prod has no distribution yet, so it exercises the fallback branch.
const prod = templates({ env: "prod" });
const devSettings = envSettings(new cdk.App());
const statements = policyStatements(ingest);

/** Statements mentioning a Secrets Manager action. */
const secretStatements = statements.filter((s) =>
  JSON.stringify(s["Action"] ?? "").includes("secretsmanager:"),
);

describe("secrets policy", () => {
  it("puts the name condition only on CreateSecret", () => {
    // secretsmanager:Name is evaluated for CreateSecret alone. The same
    // condition was applied to ListSecrets, and later to GetSecretValue, and
    // both deployed cleanly and failed at runtime with AccessDenied on a secret
    // the function had just created.
    for (const s of secretStatements) {
      const cond = JSON.stringify(s["Condition"] ?? {});
      if (!cond.includes("secretsmanager:Name")) continue;
      const actions = ([] as string[]).concat(s["Action"] as string | string[]);
      expect(actions.every((a) => a === "secretsmanager:CreateSecret" || a === "secretsmanager:TagResource")).toBe(true);
    }
  });

  it("never scopes ListSecrets by resource", () => {
    // ListSecrets cannot be scoped at all; a resource ARN silently denies it.
    for (const s of secretStatements) {
      const actions = ([] as string[]).concat(s["Action"] as string | string[]);
      if (!actions.includes("secretsmanager:ListSecrets")) continue;
      expect(s["Resource"]).toBe("*");
      expect(s["Condition"]).toBeUndefined();
    }
  });

  it("never grants value access by wildcard", () => {
    // Two resources are legitimately reachable: the connection secrets, by ARN
    // pattern, and the TrueLayer client secret, imported from Foundation. What
    // must never appear is "*".
    const value = secretStatements.filter((s) =>
      ([] as string[]).concat(s["Action"] as string | string[]).includes("secretsmanager:GetSecretValue"),
    );
    expect(value.length).toBeGreaterThan(0);
    for (const s of value) {
      const resources = JSON.stringify(s["Resource"]);
      expect(resources).not.toBe('"*"');
    }
    expect(JSON.stringify(value)).toContain("connections");
  });
});

describe("sync state machine", () => {
  it("retries a failing item and captures the failure rather than sinking the run", () => {
    // One account failing used to leave it stale until the next day. The retry
    // is the reason the decomposition exists; the catch is why one bad account
    // cannot take the others down.
    const machines = ingest.findResources("AWS::StepFunctions::StateMachine");
    const definition = JSON.stringify(Object.values(machines)[0]);
    expect(definition).toContain("FetchItem");
    expect(definition).toContain("Retry");
    expect(definition).toContain("Catch");
  });
});

describe("schedules", () => {
  it("syncs daily and categorises an hour later", () => {
    // Unattended access is capped at four calls per 24 hours per account,
    // endpoint and consent, so
    // daily. Categorisation follows the sync rather than racing it.
    ingest.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "cron(0 5 * * ? *)",
    });
    ingest.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "cron(0 6 * * ? *)",
    });
  });

  it("transforms each raw object as it lands", () => {
    ingest.hasResourceProperties("AWS::Events::Rule", {
      EventPattern: Match.objectLike({
        source: ["aws.s3"],
        "detail-type": ["Object Created"],
      }),
    });
  });
});

describe("lambda sizing", () => {
  it("stays within the new-account memory quota", () => {
    // 512 is the ceiling until the account's Lambda quota is raised; 1024 was
    // rejected at deploy.
    for (const fn of Object.values(ingest.findResources("AWS::Lambda::Function"))) {
      const memory = (fn as any).Properties?.MemorySize;
      if (memory !== undefined) expect(memory).toBeLessThanOrEqual(512);
    }
  });
});

describe("alerting", () => {
  it("has a topic and no subscription, so nothing claims to notify anyone", () => {
    // The subscription this replaces asserted that an email address was
    // configured, and it passed for the whole time alerting was dead: an SNS
    // email subscription delivers nothing until the recipient clicks a
    // confirmation link, that link was never clicked, and SNS discarded the
    // pending subscription after three days. CloudFormation kept reporting
    // CREATE_COMPLETE, so the template, the stack and this test all described
    // delivery that did not exist.
    //
    // A test can assert a subscription resource exists. It cannot assert anyone
    // receives anything, which is the only thing that mattered — so the honest
    // position is no subscription, and alarm history read directly.
    expect(Object.keys(ingest.findResources("AWS::SNS::Subscription"))).toHaveLength(0);
    // The topic stays: steps.ts publishes to it when ALERT_TOPIC_ARN is set and
    // the anomaly alarm targets it, so it is a live seam rather than decoration.
    expect(Object.keys(ingest.findResources("AWS::SNS::Topic"))).toHaveLength(1);
  });
});

describe("a raw object the transform could not handle", () => {
  it("is parked rather than dropped", () => {
    // EventBridge retries a failed invocation and then discards it, silently. On
    // the daily path the next sync re-lands the object; on a one-time load, such
    // as copying the raw zone into a new account, there is no next sync and the
    // ledger is permanently short by whatever that object held.
    ingest.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
      MaximumRetryAttempts: 2,
      DestinationConfig: { OnFailure: { Destination: Match.anyValue() } },
    });
  });

  it("keeps it long enough for a person to notice", () => {
    // Fourteen days is SQS's maximum. The alarm is the mechanism; this is the
    // backstop for the fortnight nobody looked.
    ingest.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "tightarse-dev-transform-failures",
      MessageRetentionPeriod: 1_209_600,
      SqsManagedSseEnabled: true,
    });
  });

  it("alarms on a single parked object, not on a rate", () => {
    // One is enough: the ledger is short right now, and every balance derived
    // after that object is wrong while the numbers stay plausible.
    ingest.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "tightarse-dev-transform-failures",
      MetricName: "ApproximateNumberOfMessagesVisible",
      Threshold: 0,
      ComparisonOperator: "GreaterThanThreshold",
      TreatMissingData: "notBreaching",
      AlarmActions: Match.anyValue(),
    });
  });

  it("retains the queue in prod, where a parked object cannot be re-synced", () => {
    // dev is meant to be wiped. In prod the queue holds the only record of which
    // objects need replaying, so destroying it with the stack loses the list.
    prod.ingest.hasResource("AWS::SQS::Queue", { DeletionPolicy: "Retain" });
  });
});

describe("monitoring", () => {
  it("alarms when any item fails", () => {
    // Four items failed every day for two days and only an execution's output
    // said so, which nobody reads.
    ingest.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "ItemsFailed",
      Namespace: "Tightarse",
      Threshold: 0,
      ComparisonOperator: "GreaterThanThreshold",
    });
  });

  it("alarms on an account transaction with no running balance", () => {
    // The running balance on each transaction is the primary balance data — a
    // balance endpoint is a snapshot and cannot say how the position moved. A
    // settled row without one is a gap in that series. See #30.
    ingest.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "UnanchoredAccountTransactions",
      Namespace: "Tightarse",
      Threshold: 0,
      ComparisonOperator: "GreaterThanThreshold",
      TreatMissingData: "notBreaching",
    });
  });

  it("does NOT alarm on card transactions, which never carry one", () => {
    // Measured against the live ledger: 0 of 278 card transactions have a
    // running balance, against 9,498 of 9,498 account transactions. A card
    // alarm at a threshold of zero would fire on every sync for ever, and an
    // alarm that always fires trains everyone to ignore the one that matters.
    // The metric is still emitted, so a change in provider behaviour shows up
    // in the graph.
    const alarms = ingest.findResources("AWS::CloudWatch::Alarm");
    const onCards = Object.values(alarms).filter(
      (a: any) => a.Properties?.MetricName === "UnanchoredCardTransactions",
    );
    expect(onCards).toHaveLength(0);
  });

  it.each([
    ["ReconciliationBreaksAccount", "account"],
    ["ReconciliationBreaksCard", "card"],
  ])("alarms on %s", (metricName) => {
    // balance(newest) - balance(oldest) == sum of amounts between. A break
    // means a transaction is missing, or one is present that should not be, and
    // nothing detected that before — the numbers just stayed plausible.
    //
    // Both, unlike the unanchored pair: this check needs no running balance, so
    // it covers cards, which carry none. Run against five years of real data
    // first — 5 accounts, 5 checks, 0 breaks — because a threshold of zero on
    // something that fires routinely is worse than no alarm at all.
    ingest.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: metricName,
      Namespace: "Tightarse",
      Threshold: 0,
      ComparisonOperator: "GreaterThanThreshold",
      TreatMissingData: "notBreaching",
    });
  });

  it("alarms only on balance staleness far beyond normal caching", () => {
    // Accounts were fresh in all 22 real readings; cards stale in 8 of 23, worst
    // 32 minutes. Caching of tens of minutes is normal and must not fire — the
    // mistake corrected in 927c593. A day is where a reading would land on the
    // wrong side of a reconciliation window.
    ingest.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "BalanceStalenessSeconds",
      Statistic: "Maximum",
      Threshold: 86400,
      ComparisonOperator: "GreaterThanThreshold",
    });
  });

  it("runs the reconciliation on a schedule, after the categoriser", () => {
    // It has to see a settled ledger. The sync is at 05:00 and the categoriser
    // at 06:00, so this is at 07:00.
    ingest.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "cron(0 7 * * ? *)",
    });
  });

  it("gives the reconciliation write access, because it marks readings dirty", () => {
    // Read-only would fail at the moment it found something, which is the worst
    // possible time to discover a permissions mistake.
    const fns = ingest.findResources("AWS::Lambda::Function");
    const found = Object.entries(fns).find(([id]) => id.startsWith("Reconcile"));
    expect(found, "no Reconcile function").toBeDefined();
    expect((found![1] as any).Properties.Environment.Variables.ENVIRONMENT).toBe("dev");
  });

  it("sends the unanchored alarms somewhere a person will see", () => {
    // An alarm with no action is a light nobody is looking at. This project's
    // recurring failure is infrastructure that deploys perfectly and does
    // nothing, so the wiring is asserted rather than assumed.
    const alarms = ingest.findResources("AWS::CloudWatch::Alarm");
    const unanchored = Object.values(alarms).filter((a: any) =>
      String(a.Properties?.MetricName ?? "").startsWith("Unanchored"),
    );
    expect(unanchored).toHaveLength(1);
    for (const alarm of unanchored) {
      expect((alarm as any).Properties.AlarmActions?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it.each(["Transform", "SyncSteps", "Categorise"])(
    "gives %s the deployment name its metrics are dimensioned on",
    (construct) => {
      // Every function that calls emit() needs this. The sync did not have it,
      // so it published Environment=live while the alarms watched dev — three
      // alarms that could not fire, sitting in INSUFFICIENT_DATA and looking
      // healthy because they treat missing data as not breaching. See #31.
      const fns = ingest.findResources("AWS::Lambda::Function");
      const found = Object.entries(fns).find(([id]) => id.startsWith(construct));
      expect(found, `no ${construct} function`).toBeDefined();
      expect((found![1] as any).Properties.Environment.Variables.ENVIRONMENT).toBe("dev");
    },
  );

  it("dimensions the transform function's metrics with the environment", () => {
    // emit() defaults to "dev" when ENVIRONMENT is unset, so without this every
    // metric prod produces lands under dev and prod's alarms watch dev's data.
    const fns = ingest.findResources("AWS::Lambda::Function");
    const [, transform] = Object.entries(fns).find(([id]) => id.startsWith("Transform")) as [string, any];
    expect(transform.Properties.Environment.Variables.ENVIRONMENT).toBe("dev");
  });

  it("alarms before a consent lapses, not on the day", () => {
    ingest.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "ConsentDaysRemaining",
      Statistic: "Minimum",
      Threshold: 10,
      ComparisonOperator: "LessThanOrEqualToThreshold",
    });
  });

  it("watches transactions fetched with anomaly detection, not a threshold", () => {
    // Zero is normal for a dormant account. A threshold would page for nothing
    // and train everyone to ignore the alarm that matters.
    expect(
      Object.keys(ingest.findResources("AWS::CloudWatch::AnomalyDetector")).length,
    ).toBe(1);
    ingest.hasResourceProperties("AWS::CloudWatch::Alarm", {
      ComparisonOperator: "LessThanLowerOrGreaterThanUpperThreshold",
      ThresholdMetricId: "band",
      Metrics: Match.arrayWith([
        Match.objectLike({ Id: "band", Expression: "ANOMALY_DETECTION_BAND(fetched, 2)" }),
      ]),
    });
  });

  it("sends every alarm to the alert topic", () => {
    // An alarm nobody is told about is a dashboard widget.
    for (const [id, alarm] of Object.entries(ingest.findResources("AWS::CloudWatch::Alarm"))) {
      expect((alarm as any).Properties?.AlarmActions, `alarm ${id}`).toBeDefined();
      expect((alarm as any).Properties?.AlarmActions.length, `alarm ${id}`).toBeGreaterThan(0);
    }
  });

  it("dimensions our own metrics by environment only", () => {
    // Every distinct dimension combination is separately billed, and an alarm in
    // CDK cannot name a connection created at runtime.
    //
    // Ours only. An AWS-native metric is dimensioned by whatever AWS chose —
    // AWS/SQS by QueueName — and cannot be re-dimensioned. That is not the
    // cardinality this guards against: there is one queue, its name carries the
    // environment, and the metric is a standard one rather than a custom one we
    // pay per combination for.
    for (const alarm of Object.values(ingest.findResources("AWS::CloudWatch::Alarm"))) {
      const props = (alarm as any).Properties;
      if (props?.Namespace !== "Tightarse") continue;
      const dims = props?.Dimensions;
      if (!dims) continue;
      expect(dims.map((d: any) => d.Name)).toEqual(["Environment"]);
    }
  });

  it("keeps an AWS-native alarm inside its own environment by name", () => {
    // The separation the rule above exists for still has to hold: a dev alarm
    // must not watch prod's queue. It is enforced by the queue name rather than
    // by a dimension, so it is worth asserting rather than assuming.
    const dev = Object.values(ingest.findResources("AWS::CloudWatch::Alarm")).find(
      (a: any) => a.Properties?.MetricName === "ApproximateNumberOfMessagesVisible",
    ) as any;
    // Resolved from the queue's own name attribute, so it can only ever point at
    // the queue in this stack.
    expect(dev.Properties.Dimensions[0].Name).toBe("QueueName");
    expect(dev.Properties.Dimensions[0].Value["Fn::GetAtt"][1]).toBe("QueueName");
  });
});

describe("where the bank sends the browser back", () => {
  it("derives the redirect from the deployed site", () => {
    // One source, because the two must agree — the same reasoning that put the
    // pool, its client and its hosted UI into one object. And it must match what
    // is registered with TrueLayer exactly: the provider refuses anything else,
    // and nothing in CDK can register it.
    const fns = Object.values(ingest.findResources("AWS::Lambda::Function"));
    const redirects = fns
      .map((f: any) => f.Properties.Environment?.Variables?.CONNECT_REDIRECT_URI)
      .filter((v: unknown): v is string => typeof v === "string");
    expect(redirects.length).toBeGreaterThan(0);
    for (const r of redirects) expect(r).toMatch(/^https:\/\/.*cloudfront\.net\/connected$/);
  });

  it("falls back to the dev server when no site is deployed", () => {
    // A redirect pointing at a site that does not exist fails at the bank rather
    // than here, and a failed authorisation costs the consent it was spent on.
    //
    // Tested against the function rather than against whichever environment
    // happens to lack a siteUrl. It used to read prod, which had none — then prod
    // got a domain of its own and the fallback quietly stopped being exercised by
    // anything. An environment's incidental configuration is not a fixture.
    expect(connectRedirectUri({ ...devSettings, siteUrl: undefined })).toBe(
      "http://localhost:5173/connected",
    );
  });

  it("derives from siteUrl once there is one, whoever assigned it", () => {
    // CloudFront's own domain in dev, ours in prod. The rule is the same and the
    // path is appended rather than configured, because two fields that must agree
    // are two things to get wrong.
    expect(connectRedirectUri({ ...devSettings, siteUrl: "https://example.test" })).toBe(
      "https://example.test/connected",
    );
  });
});
