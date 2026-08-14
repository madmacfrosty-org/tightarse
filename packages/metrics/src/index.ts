/**
 * Metrics, in CloudWatch's Embedded Metric Format.
 *
 * A structured line on stdout that CloudWatch reads as both a log entry and a
 * metric. Chosen over PutMetricData because it needs no API call, no IAM grant
 * and no latency in the request path — and because the same line stays greppable
 * when you want to know what actually happened rather than how much of it.
 *
 * ## Dimensions cost money; properties do not
 *
 * Every distinct combination of dimension values is a separate custom metric,
 * billed monthly. So the dimension is the environment and nothing else, and
 * anything high-cardinality — which connection, which account — is emitted as a
 * PROPERTY. Properties are searchable in Logs Insights and free.
 *
 * That also keeps alarms possible. Connection ids are created at runtime, so an
 * alarm defined in CDK cannot name one; alarming on the household-wide metric
 * works whatever connections exist.
 *
 * ## Never emit anything about a transaction
 *
 * Counts, durations and identifiers only. A description is a merchant, a person
 * or an employer, and CloudWatch is not where those belong.
 */

export interface MetricDefinition {
  readonly name: string;
  readonly unit: "Count" | "Milliseconds" | "Seconds" | "None";
}

export interface EmitInput {
  readonly namespace: string;
  readonly environment: string;
  /** Metric name to value. Only these become metrics. */
  readonly metrics: Readonly<Record<string, number>>;
  /** Units, defaulting to Count for anything unlisted. */
  readonly units?: Readonly<Record<string, MetricDefinition["unit"]>>;
  /** Logged and searchable, never charged, never alarmed on. */
  readonly properties?: Readonly<Record<string, string | number | boolean>>;
  readonly timestamp?: number;
}

/** The Embedded Metric Format document for one emission. */
export function metricDocument(input: EmitInput): Record<string, unknown> {
  const names = Object.keys(input.metrics);
  if (names.length === 0) throw new Error("Refusing to emit a metric document with no metrics");

  return {
    _aws: {
      Timestamp: input.timestamp ?? Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: input.namespace,
          // One dimension. See the note above on cost and on alarms.
          Dimensions: [["Environment"]],
          Metrics: names.map((name) => ({ Name: name, Unit: input.units?.[name] ?? "Count" })),
        },
      ],
    },
    Environment: input.environment,
    ...input.properties,
    ...input.metrics,
  };
}

/**
 * Write one metric document.
 *
 * Takes its sink so a test can read what was emitted without capturing global
 * console state.
 */
export function emit(input: EmitInput, write: (line: string) => void = console.log): void {
  write(JSON.stringify(metricDocument(input)));
}
