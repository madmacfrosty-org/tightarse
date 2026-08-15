import { describe, it, expect } from "vitest";
import { Match } from "aws-cdk-lib/assertions";
import { templates, policyStatements } from "./harness";

const { ingest } = templates();
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
  it("subscribes the configured address", () => {
    ingest.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "email",
      Endpoint: "alerts@example.com",
    });
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

  it.each([
    ["UnanchoredCardTransactions", "card"],
    ["UnanchoredAccountTransactions", "account"],
  ])("alarms on %s, so a gap in the balance series is noticed", (metricName) => {
    // The running balance on each transaction is the primary balance data — a
    // balance endpoint is a snapshot and cannot say how the position moved. A
    // settled row without one is a gap in that series.
    //
    // Threshold of zero because this is unambiguous rather than a pattern, and
    // because we believe it will never fire. That belief is what the alarm is
    // testing. See #30 — the response is to observe, never to reconstruct.
    ingest.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: metricName,
      Namespace: "Tightarse",
      Threshold: 0,
      ComparisonOperator: "GreaterThanThreshold",
      TreatMissingData: "notBreaching",
    });
  });

  it("sends the unanchored alarms somewhere a person will see", () => {
    // An alarm with no action is a light nobody is looking at. This project's
    // recurring failure is infrastructure that deploys perfectly and does
    // nothing, so the wiring is asserted rather than assumed.
    const alarms = ingest.findResources("AWS::CloudWatch::Alarm");
    const unanchored = Object.values(alarms).filter((a: any) =>
      String(a.Properties?.MetricName ?? "").startsWith("Unanchored"),
    );
    expect(unanchored).toHaveLength(2);
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

  it("dimensions metrics by environment only", () => {
    // Every distinct dimension combination is separately billed, and an alarm
    // in CDK cannot name a connection created at runtime.
    for (const alarm of Object.values(ingest.findResources("AWS::CloudWatch::Alarm"))) {
      const dims = (alarm as any).Properties?.Dimensions;
      if (!dims) continue;
      expect(dims.map((d: any) => d.Name)).toEqual(["Environment"]);
    }
  });
});
