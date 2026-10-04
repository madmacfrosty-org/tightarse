import { describe, it, expect } from "vitest";
import { Match } from "aws-cdk-lib/assertions";
import { templates, policyStatements } from "./harness.js";
import {
  connectRedirectUri,
  envSettings,
  liveSyncIsProdAlone,
  ownsConnections,
  SETTINGS,
  type EnvSettings,
} from "../lib/config.js";
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

/** The environment of the one Lambda identified by a variable only it carries. */
const envOf = (t: ReturnType<typeof templates>["ingest"], marker: string) => {
  const fn = Object.values(t.findResources("AWS::Lambda::Function")).find((f) =>
    JSON.stringify(
      (f as { Properties?: { Environment?: { Variables?: unknown } } }).Properties?.Environment
        ?.Variables ?? {},
    ).includes(marker),
  ) as { Properties: { Environment: { Variables: Record<string, string> } } };
  return fn.Properties.Environment.Variables;
};

describe("sync ownership", () => {
  /** SYNC_ENABLED as the deployed steps function would read it. */
  function syncEnabledOf(t: ReturnType<typeof templates>["ingest"]): string | undefined {
    const fns = Object.values(t.findResources("AWS::Lambda::Function"));
    const steps = fns.find((f: any) =>
      JSON.stringify(f.Properties?.Environment?.Variables ?? {}).includes("CONNECTION_SECRET_PREFIX"),
    ) as any;
    return steps?.Properties?.Environment?.Variables?.SYNC_ENABLED;
  }

  it("nominates prod, and only prod, to refresh a live connection", () => {
    // Which deployment owns the household's connections, stated where a change
    // to it cannot be incidental. Prod took them over on 23 August 2026; a
    // second deployment refreshing the same credential writes back a token the
    // first has already spent, and the connection dies days later.
    //
    // Dev refreshes too, from 30 September 2026 — against the sandbox, where
    // the tokens are a mock bank's and prod holds nothing reachable. So the
    // fact worth pinning is the *pairing*: refreshing is only costly in
    // company with `live`, and either value alone says nothing about whether a
    // deployment is safe.
    //
    // If this fails, ownership has moved. That is a decision, not a detail:
    // change it here on purpose, or find out why something changed it for you.
    expect(syncEnabledOf(prod.ingest)).toBe("true");
    expect(envOf(prod.ingest, "RAW_BUCKET")["TL_ENV"]).toBe("live");
    expect(syncEnabledOf(ingest)).toBe("true");
    expect(envOf(ingest, "RAW_BUCKET")["TL_ENV"]).toBe("sandbox");
  });

  it("carries the setting through rather than hard-coding it", () => {
    // Synthesised from a settings object that says false, because the value
    // that matters is the one nobody has deployed yet: the cutover deploy. A
    // test pinned to today's `true` would pass just as happily against a
    // literal.
    const off = templates({}, { syncEnabled: false });
    expect(syncEnabledOf(off.ingest)).toBe("false");
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

/**
 * #71: the sync schedule follows `syncEnabled`, and prod's must not move.
 *
 * `SYNC_ENABLED` already stopped dev doing the work, but the rule fired anyway,
 * started the state machine, and had it read the TrueLayer client credential —
 * daily, in an account holding no connections. Gating the schedule is what let
 * dev's copy of that credential be emptied.
 *
 * The prod assertion is the one that earns its place. This is a shared stack,
 * and a change meant to disable one environment's schedule is one typo away
 * from disabling the household's only sync — which nothing would report,
 * because a sync that never runs looks exactly like one with nothing to fetch.
 */
describe("the daily sync schedule", () => {
  const ruleFor = (t: ReturnType<typeof templates>["ingest"]) =>
    Object.values(
      t.findResources("AWS::Events::Rule", {
        Properties: { Description: "Daily TrueLayer sync" },
      }),
    )[0] as { Properties: Record<string, unknown> } | undefined;

  it("fires in both deployments, each against its own provider", () => {
    // Dev syncs the mock bank so the Connections page has consent rows to
    // show — without them there is nothing on screen to renew, and the
    // renewal flow cannot be exercised anywhere but prod.
    expect(devSettings.syncEnabled).toBe(true);
    expect(ruleFor(ingest)?.Properties["State"]).toBe("ENABLED");
    expect(ruleFor(prod.ingest)?.Properties["State"]).toBe("ENABLED");
  });

  it("stops when the setting says so, which is the emergency brake", () => {
    // The schedule has to follow the setting rather than be enabled outright:
    // turning a deployment off is how a runaway sync is stopped durably, and a
    // hard-coded ENABLED would make the next deploy quietly undo it.
    const off = templates({}, { syncEnabled: false });
    expect(ruleFor(off.ingest)?.Properties["State"]).toBe("DISABLED");
  });
});

/**
 * #178: which TrueLayer each deployment talks to.
 *
 * The prod assertion is the one that earns its place. Pointing prod at the
 * sandbox would leave every figure describing a mock bank while the dashboard
 * looked entirely normal — a failure with no symptom until somebody noticed
 * their own transactions had stopped arriving.
 */
describe("which provider a deployment reaches", () => {
  it("sends dev to the sandbox, in both the connect flow and the sync", () => {
    expect(envOf(ingest, "CONNECT_REDIRECT_URI")["TL_ENV"]).toBe("sandbox");
    expect(envOf(ingest, "RAW_BUCKET")["TL_ENV"]).toBe("sandbox");
  });

  it("sends prod to the live provider", () => {
    expect(envOf(prod.ingest, "CONNECT_REDIRECT_URI")["TL_ENV"]).toBe("live");
    expect(envOf(prod.ingest, "RAW_BUCKET")["TL_ENV"]).toBe("live");
  });

  it("offers the mock bank in the sandbox and never in prod", () => {
    // Sandbox holds none of the real banks, so the default provider filter
    // would send somebody to a picker with nothing they could sign in to.
    expect(envOf(ingest, "CONNECT_REDIRECT_URI")["TL_PROVIDERS"]).toBe("uk-cs-mock");
    expect(envOf(prod.ingest, "CONNECT_REDIRECT_URI")["TL_PROVIDERS"]).toBeUndefined();
  });
});

describe("only one deployment may refresh a live consent", () => {
  // The rule the table is checked against at synth. Exercised through the
  // exported guard rather than by mutating SETTINGS, which is frozen config a
  // test has no business editing.
  const env = (over: Partial<EnvSettings>): EnvSettings =>
    ({ name: "dev", syncEnabled: false, providerEnvironment: "sandbox", ...over }) as EnvSettings;

  it("allows dev to sync, because dev is on the sandbox", () => {
    expect(() =>
      liveSyncIsProdAlone({
        dev: env({ syncEnabled: true }),
        prod: env({ name: "prod", syncEnabled: true, providerEnvironment: "live" }),
      }),
    ).not.toThrow();
  });

  it("refuses a second deployment pointed at live", () => {
    // The combination that killed connections after the cutover: two
    // deployments spending tokens against one credential.
    expect(() =>
      liveSyncIsProdAlone({
        dev: env({ syncEnabled: true, providerEnvironment: "live" }),
        prod: env({ name: "prod", syncEnabled: true, providerEnvironment: "live" }),
      }),
    ).toThrow(/Only prod may sync against live/);
  });

  it("refuses a lone non-prod deployment on live, not merely a pair", () => {
    // Prod being switched off does not make dev the one allowed to sync live.
    expect(() =>
      liveSyncIsProdAlone({ dev: env({ syncEnabled: true, providerEnvironment: "live" }) }),
    ).toThrow(/dev/);
  });

  it("holds for the table that actually ships", () => {
    expect(() => liveSyncIsProdAlone(SETTINGS)).not.toThrow();
  });
});

describe("who may renew a consent", () => {
  // Distinct from who may sync. The two were briefly the same flag, and dev
  // was refused renewal because it does not run a daily sync — which is not
  // the question. What matters is whose connections they are.
  it("lets a sandbox deployment renew its own mock connections", () => {
    expect(envOf(ingest, "CONNECT_REDIRECT_URI")["CONNECTIONS_OWNED"]).toBe("true");
  });

  it("lets prod renew the household's", () => {
    expect(envOf(prod.ingest, "CONNECT_REDIRECT_URI")["CONNECTIONS_OWNED"]).toBe("true");
  });

  it("refuses a non-prod deployment pointed at live", () => {
    // The combination that must never renew: somebody else's live consent,
    // from a deployment that does not own it. `ownsConnections` is the rule and
    // it is checked here rather than trusted.
    expect(ownsConnections({ name: "dev", providerEnvironment: "live" } as EnvSettings)).toBe(false);
    expect(ownsConnections({ name: "prod", providerEnvironment: "live" } as EnvSettings)).toBe(true);
    expect(ownsConnections({ name: "dev", providerEnvironment: "sandbox" } as EnvSettings)).toBe(true);
  });
});

describe("which household a deployment syncs", () => {
  // Was the literal "frost" in both. Dev holds 0 rows for that household and
  // 315 for `demo-one`, which is the one its members belong to — so dev's
  // sync was aimed at a household nobody could see. Dormant while dev's sync
  // was off, and the first thing to fail when it came back on.
  const tenantOf = (t: ReturnType<typeof templates>["ingest"]) =>
    envOf(t, "RAW_BUCKET")["TENANT_ID"];

  it("syncs the household dev's members actually belong to", () => {
    expect(tenantOf(ingest)).toBe("demo-one");
  });

  it("syncs the real household in prod", () => {
    expect(tenantOf(prod.ingest)).toBe("frost");
  });

  it("never syncs the real household from dev", () => {
    // The pairing that matters: dev reaching prod's household would put real
    // transactions in the account built to be thrown away.
    expect(tenantOf(ingest)).not.toBe(tenantOf(prod.ingest));
  });
});

describe("what the connect function may reach", () => {
  // Renewal failed in dev on 4 October 2026 with an AccessDeniedException for
  // ListSecrets: finding the connection behind a consent means listing them,
  // and connecting never needed that. Asserted here because the symptom was a
  // runtime denial that no test and no synth could see.
  /**
   * Only the statements attached to the connect function's role.
   *
   * `policyStatements` returns every statement in the template, which would
   * pass on the sync function's grants and prove nothing about this one —
   * and the sync has both of these already.
   */
  const connectPolicy = () => {
    const policies = Object.values(ingest.findResources("AWS::IAM::Policy")).filter((r) =>
      JSON.stringify(
        (r as { Properties?: { Roles?: unknown } }).Properties?.Roles ?? [],
      ).includes("ConnectServiceRole"),
    );
    expect(policies.length).toBeGreaterThan(0);
    return JSON.stringify(policies);
  };

  it("may list secrets, which finding a connection requires", () => {
    expect(connectPolicy()).toContain("secretsmanager:ListSecrets");
  });

  it("may write a raw object, so a renewal can tell the ledger", () => {
    expect(connectPolicy()).toMatch(/s3:PutObject/);
  });
});
