import { describe, it, expect, vi } from "vitest";
import { handlerConfig, keyFromEvent, processObject, realDeps, type TransformHandlerDeps } from "./transform-handler.js";
import type { TransformResult } from "@tightarse/transform";

/**
 * What this handler reports about an object it just transformed.
 *
 * The reporting is the point: a settled transaction with no running balance is
 * a gap in the balance series, and #30 is the decision to observe that rather
 * than reconstruct it. An alarm nobody wired up is the failure mode this
 * project keeps having.
 */

const result = (over: Partial<TransformResult> = {}): TransformResult => ({
  key: "tenant=frost/dataset=truelayer.transactions/account=acc-1/x.json.gz",
  dataset: "truelayer.transactions",
  handler: "settled",
  rows: 3,
  ...over,
});

function deps(r: TransformResult): { deps: TransformHandlerDeps; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    deps: {
      transform: async () => r,
      environment: "prod",
      log: (line: string) => lines.push(line),
    },
  };
}

const event = (key: string) => ({ detail: { object: { key } } });

const metricsIn = (lines: string[]): Array<Record<string, number>> =>
  lines
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((d) => "_aws" in d)
    .map((d) => d as Record<string, number>);

describe("the key an event carries", () => {
  it("decodes the partition markers, which arrive percent-encoded", () => {
    // Our keys contain '=' in every segment. Transforming the encoded form
    // would fail to parse a tenant or a dataset out of it.
    expect(keyFromEvent(event("tenant%3Dfrost/dataset%3Dtruelayer.transactions/x.json.gz"))).toBe(
      "tenant=frost/dataset=truelayer.transactions/x.json.gz",
    );
  });

  it("turns a plus back into a space rather than leaving it", () => {
    // EventBridge encodes spaces as '+', and decodeURIComponent alone does not
    // reverse that.
    expect(keyFromEvent(event("tenant%3Dfrost/dataset%3Da+b/x.json.gz"))).toContain("a b");
  });
});

describe("reporting a settled transactions object", () => {
  it("emits the unanchored counts, split by card and account", async () => {
    const { deps: d, lines } = deps(result({ unanchored: { card: 2, account: 1 } }));
    await processObject(d, event("k"));
    const [metric] = metricsIn(lines);
    expect(metric!["UnanchoredCardTransactions"]).toBe(2);
    expect(metric!["UnanchoredAccountTransactions"]).toBe(1);
  });

  it("emits zeroes when every row carried a running balance", async () => {
    // A run that emits nothing is indistinguishable from a run that did not
    // happen, which is how an alarm ends up watching an empty dimension.
    const { deps: d, lines } = deps(result({ unanchored: { card: 0, account: 0 } }));
    await processObject(d, event("k"));
    expect(metricsIn(lines)).toHaveLength(1);
  });

  it("dimensions the metric on the deployment it was given", async () => {
    // Not the TrueLayer environment. A metric emitted under "live" is invisible
    // to an alarm watching "dev", and the alarm then never fires for any reason.
    const { deps: d, lines } = deps(result({ unanchored: { card: 0, account: 0 } }));
    await processObject(d, event("k"));
    expect(JSON.parse(lines.find((l) => l.includes("_aws"))!)["Environment"]).toBe("prod");
  });
});

describe("objects that could never carry a running balance", () => {
  it("emits no metric for a balance object", async () => {
    // Absent, not zero. Emitting for these would bury the signal under objects
    // the question does not apply to.
    const { deps: d, lines } = deps(result({ dataset: "truelayer.balance", handler: "balance", rows: 1 }));
    await processObject(d, event("k"));
    expect(metricsIn(lines)).toHaveLength(0);
  });

  it("still logs the counts for one", async () => {
    const { deps: d, lines } = deps(result({ dataset: "truelayer.balance", handler: "balance", rows: 1 }));
    await processObject(d, event("k"));
    expect(JSON.parse(lines[0]!)).toEqual({ dataset: "truelayer.balance", handler: "balance", rows: 1 });
  });
});

describe("what reaches CloudWatch", () => {
  it("logs counts only, never anything from a transaction", async () => {
    // A description is a merchant, a person's name, or an employer. The whole
    // reason this repository keeps raw data in S3 and counts in logs.
    const { deps: d, lines } = deps(result({ unanchored: { card: 1, account: 0 } }));
    await processObject(d, event("k"));
    const everything = lines.join(" ");
    for (const forbidden of ["description", "merchant", "amount"]) {
      expect(everything).not.toContain(forbidden);
    }
  });
});

describe("reading the environment", () => {
  it("takes every value the deployment provides", () => {
    expect(
      handlerConfig({
        RAW_BUCKET: "raw-bucket",
        TABLE_NAME: "Ledger",
        AWS_REGION: "eu-west-2",
        ENVIRONMENT: "prod",
      }),
    ).toEqual({ bucket: "raw-bucket", tableName: "Ledger", region: "eu-west-2", environment: "prod" });
  });

  it("falls back on every value when nothing is set", () => {
    // Both sides are asserted so branch coverage does not depend on which
    // machine ran the suite: AWS_REGION is set in CI and unset on a laptop.
    expect(handlerConfig({})).toEqual({
      bucket: "",
      tableName: "",
      region: "eu-west-1",
      environment: "dev",
    });
  });

  it("defaults the metric dimension to dev rather than leaving it undefined", () => {
    // An unset dimension emits under "undefined" and no alarm ever matches it.
    expect(handlerConfig({}).environment).toBe("dev");
  });
});

describe("building the real dependencies", () => {

  it("writes to the console when no writer is supplied", async () => {
    // The Lambda has no writer to give it, so this is the path that actually
    // runs in production.
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { deps: d } = deps(result({ unanchored: { card: 0, account: 0 } }));
    await processObject({ transform: d.transform, environment: d.environment }, event("k"));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("defaults the metric dimension to dev rather than leaving it unset", () => {
    // An unset dimension would emit under "undefined" and no alarm would ever
    // match it.
    expect(realDeps().environment).toBe("dev");
  });

  it("provides a transform function rather than raw clients", () => {
    expect(typeof realDeps().transform).toBe("function");
  });
});

describe("reporting how stale a balance was", () => {
  it("emits the staleness for a balance object", async () => {
    // Watched rather than assumed: the card balance endpoint documents
    // update_timestamp not at all, so this is what would say if it stopped
    // meaning what we take it to mean.
    const { deps: d, lines } = deps(result({ dataset: "truelayer.card_balance", handler: "balance", rows: 1, staleness: 1920 }));
    await processObject(d, event("k"));
    const doc = metricsIn(lines).find((m) => "BalanceStalenessSeconds" in m);
    expect(doc!["BalanceStalenessSeconds"]).toBe(1920);
  });

  it("emits zero rather than nothing when the provider gave no timestamp", async () => {
    // No evidence of staleness is itself a data point, and a metric that only
    // appears on stale readings cannot show that the rest were fresh.
    const { deps: d, lines } = deps(result({ dataset: "truelayer.balance", handler: "balance", rows: 1, staleness: 0 }));
    await processObject(d, event("k"));
    expect(metricsIn(lines).find((m) => "BalanceStalenessSeconds" in m)!["BalanceStalenessSeconds"]).toBe(0);
  });

  it("emits nothing for an object that is not a balance", async () => {
    const { deps: d, lines } = deps(result({ unanchored: { card: 0, account: 0 } }));
    await processObject(d, event("k"));
    expect(metricsIn(lines).some((m) => "BalanceStalenessSeconds" in m)).toBe(false);
  });
});
