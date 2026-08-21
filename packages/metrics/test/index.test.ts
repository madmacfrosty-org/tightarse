import { describe, it, expect } from "vitest";
import { metricDocument, emit } from "../src/index.js";

const base = { namespace: "Tightarse", environment: "dev", timestamp: 1_700_000_000_000 };

describe("metricDocument", () => {
  it("declares every metric it carries", () => {
    const doc = metricDocument({ ...base, metrics: { TransactionsFetched: 61, ItemsFailed: 0 } });
    const declared = (doc["_aws"] as any).CloudWatchMetrics[0].Metrics.map((m: any) => m.Name);
    expect(declared.sort()).toEqual(["ItemsFailed", "TransactionsFetched"]);
    expect(doc["TransactionsFetched"]).toBe(61);
    expect(doc["ItemsFailed"]).toBe(0);
  });

  it("dimensions on environment alone", () => {
    // Every distinct dimension combination is a separately billed metric, and
    // an alarm defined in CDK cannot name a connection created at runtime.
    const doc = metricDocument({ ...base, metrics: { X: 1 }, properties: { ConnectionId: "conn-1" } });
    expect((doc["_aws"] as any).CloudWatchMetrics[0].Dimensions).toEqual([["Environment"]]);
    expect(doc["Environment"]).toBe("dev");
  });

  it("carries high-cardinality context as a property, not a dimension", () => {
    const doc = metricDocument({
      ...base,
      metrics: { TransactionsFetched: 3 },
      properties: { ConnectionId: "conn-1", Provider: "truelayer" },
    });
    const declared = (doc["_aws"] as any).CloudWatchMetrics[0].Metrics.map((m: any) => m.Name);
    expect(declared).toEqual(["TransactionsFetched"]);
    // Present in the document, and so searchable, but not a metric.
    expect(doc["ConnectionId"]).toBe("conn-1");
  });

  it("defaults a unit to Count and honours an override", () => {
    const doc = metricDocument({
      ...base,
      metrics: { TransactionsFetched: 1, SyncDurationMs: 4200 },
      units: { SyncDurationMs: "Milliseconds" },
    });
    const units = Object.fromEntries(
      (doc["_aws"] as any).CloudWatchMetrics[0].Metrics.map((m: any) => [m.Name, m.Unit]),
    );
    expect(units).toEqual({ TransactionsFetched: "Count", SyncDurationMs: "Milliseconds" });
  });

  it("refuses a document with no metrics", () => {
    // Silently emitting a log line that CloudWatch ignores is worse than
    // failing: the metric would appear to exist and never have data.
    expect(() => metricDocument({ ...base, metrics: {} })).toThrow(/no metrics/);
  });

  it("uses the supplied timestamp", () => {
    const doc = metricDocument({ ...base, metrics: { X: 1 } });
    expect((doc["_aws"] as any).Timestamp).toBe(1_700_000_000_000);
  });
});

describe("emit", () => {
  it("writes one line of JSON to the sink it is given", () => {
    const lines: string[] = [];
    emit({ ...base, metrics: { TransactionsFetched: 61 } }, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    expect(JSON.parse(lines[0]!)["TransactionsFetched"]).toBe(61);
  });
});
