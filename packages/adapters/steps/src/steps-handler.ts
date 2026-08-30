/**
 * One Lambda, several step entry points.
 *
 * A single function with a dispatch beats four deployments: the bundle and IAM
 * are identical for each, and Step Functions distinguishes them by payload.
 *
 * This is also the only place that constructs anything real — a TrueLayer
 * client, a Secrets Manager client, an S3 client. The steps take their
 * dependencies as an argument so they can be run against fakes, which they
 * could not be while this file's work happened at module scope.
 */
import { listConnections, refreshAndList, fetchItem, recordOutcome, realDeps } from "./steps.js";

type Step = "listConnections" | "refreshAndList" | "fetchItem" | "recordOutcome";

export async function handler(event: { step: Step } & Record<string, unknown>): Promise<unknown> {
  // Built per invocation, as the previous code did — each step used to fetch
  // the client secret for itself. Caching across warm invocations would save a
  // Secrets Manager call and mean a rotated secret was not picked up until the
  // next cold start, which is not a trade to make silently inside a refactor.
  const deps = await realDeps();

  switch (event.step) {
    case "listConnections":
      return listConnections(deps, event as never);
    case "refreshAndList":
      return refreshAndList(deps, event as never);
    case "fetchItem":
      return fetchItem(deps, event as never);
    case "recordOutcome":
      return recordOutcome(deps, event as never);
    default:
      throw new Error(`Unknown step: ${String(event.step)}`);
  }
}
