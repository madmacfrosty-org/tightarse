import { describe, it, expect } from "vitest";
import { realDeps } from "../src/reconcile-handler.js";

/**
 * The wiring for the scheduled reconciliation.
 *
 * The work is in `reconcileFrom`, which takes its clients as arguments and is
 * tested against fakes in @tightarse/transform. What is worth checking here is
 * that this actually builds them, and reads the environment the alarms
 * dimension on.
 */

describe("building the real dependencies", () => {
  it("constructs both clients rather than returning placeholders", () => {
    const deps = realDeps();
    expect(deps.rows).toHaveProperty("scanAll");
    expect(deps.ledger).toHaveProperty("markBalanceReadingDirty");
  });

  it("defaults the metric dimension to dev rather than leaving it undefined", () => {
    // An undefined dimension emits under "undefined" and no alarm matches it,
    // which is #31 in miniature.
    expect(realDeps().config.environment).toBe("dev");
  });

  it("defaults the household rather than failing closed on a missing variable", () => {
    // One household. A missing TENANT_ID should not stop the check running.
    expect(realDeps().config.tenantId).toBe("frost");
  });
});
