/**
 * One Lambda, several step entry points.
 *
 * A single function with a dispatch beats four deployments: the bundle and IAM
 * are identical for each, and Step Functions distinguishes them by payload.
 */
import { listConnections, refreshAndList, fetchItem, recordOutcome } from "./steps.js";

type Step = "listConnections" | "refreshAndList" | "fetchItem" | "recordOutcome";

export async function handler(event: { step: Step } & Record<string, unknown>): Promise<unknown> {
  switch (event.step) {
    case "listConnections":
      return listConnections(event as never);
    case "refreshAndList":
      return refreshAndList(event as never);
    case "fetchItem":
      return fetchItem(event as never);
    case "recordOutcome":
      return recordOutcome(event as never);
    default:
      throw new Error(`Unknown step: ${String(event.step)}`);
  }
}
