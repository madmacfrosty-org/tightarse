import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { categorise, realDeps, type CategoriseDeps } from "../src/handler.js";

/**
 * This runs on a schedule, unattended, and writes to the ledger. Until the
 * client became an argument none of it was reachable without a table and a
 * region, so the household's "off" setting — the one thing here somebody would
 * notice being wrong — had no test at all.
 */

const getSettings = vi.fn();
const listToEnrich = vi.fn();
const getCustomRules = vi.fn();
const putEnrichment = vi.fn();

const deps = (over: Partial<CategoriseDeps> = {}): CategoriseDeps => ({
  ledger: { getSettings, listToEnrich, getCustomRules, putEnrichment },
  tenantId: "frost",
  defaultBackfillDays: 45,
  environment: "test",
  ...over,
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  getSettings.mockReset().mockResolvedValue({ enrichment: "rules" });
  listToEnrich.mockReset().mockResolvedValue([]);
  getCustomRules.mockReset().mockResolvedValue([]);
  putEnrichment.mockReset().mockResolvedValue(undefined);
});

describe("the household's enrichment setting", () => {
  it("does nothing at all when enrichment is off", async () => {
    // A schedule that ignored this would keep categorising after somebody
    // turned it off, and the only evidence would be rows appearing.
    getSettings.mockResolvedValue({ enrichment: "off" });
    const result = await categorise(deps());
    expect(result).toEqual({ backlog: 0, matched: 0, written: 0, customRules: 0 });
    expect(listToEnrich).not.toHaveBeenCalled();
    expect(putEnrichment).not.toHaveBeenCalled();
  });

  it("runs the rules when a household has no setting recorded", async () => {
    // Absent means "not configured yet", not "off". Defaulting to off would
    // leave a new household silently uncategorised for ever.
    getSettings.mockResolvedValue(undefined);
    await categorise(deps());
    expect(listToEnrich).toHaveBeenCalled();
  });
});

describe("the window it reads", () => {
  it("asks for the configured lookback, not all of history", async () => {
    // The daily read is meant to be small; the backlog is derived by diffing,
    // so a wide range costs a query over five years every morning.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T06:00:00Z"));
    await categorise(deps({ defaultBackfillDays: 45 }));
    expect(listToEnrich).toHaveBeenCalledWith(
      "frost",
      { from: "2026-01-24", to: "2026-03-10" },
      undefined,
    );
    vi.useRealTimers();
  });

  it("lets an event widen the window for a backfill after a rule changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T06:00:00Z"));
    await categorise(deps(), { backfillDays: 400 });
    expect(listToEnrich).toHaveBeenCalledWith(
      "frost",
      { from: "2025-02-03", to: "2026-03-10" },
      undefined,
    );
    vi.useRealTimers();
  });

  it("reads the household it was given and not a hardcoded one", async () => {
    await categorise(deps({ tenantId: "someone-else" }));
    expect(getSettings).toHaveBeenCalledWith("someone-else");
    expect(listToEnrich).toHaveBeenCalledWith("someone-else", expect.anything(), undefined);
  });
});

describe("wiring the scheduled run", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it("builds a real store and reads its settings from the environment", () => {
    // Only the entry point may run a constructor, so nothing else covers this.
    process.env["TABLE_NAME"] = "some-table";
    process.env["TENANT_ID"] = "frost";
    process.env["BACKFILL_DAYS"] = "60";
    process.env["ENVIRONMENT"] = "prod";
    const deps = realDeps();
    expect(deps.ledger).toHaveProperty("listToEnrich");
    expect(deps).toMatchObject({ tenantId: "frost", defaultBackfillDays: 60, environment: "prod" });
  });

  it("defaults the household, the lookback and the metric dimension", () => {
    // An undefined dimension emits under "undefined" and no alarm matches it,
    // which is #31 in miniature.
    //
    // AWS_REGION is deleted deliberately. It is set in CI and in any shell that
    // has run an aws command, so leaving it inherited means the fallback below is
    // exercised or not depending on who ran the tests — this file scored 100%
    // alone and 97.29% in a full sweep for exactly that reason.
    process.env["TABLE_NAME"] = "some-table";
    delete process.env["TENANT_ID"];
    delete process.env["BACKFILL_DAYS"];
    delete process.env["ENVIRONMENT"];
    delete process.env["AWS_REGION"];
    expect(realDeps()).toMatchObject({ tenantId: "frost", defaultBackfillDays: 45, environment: "dev" });
  });

  it("uses AWS_REGION when the environment sets one", () => {
    // The other half of the same fallback, so neither side depends on the
    // ambient environment of whoever is running the suite.
    process.env["TABLE_NAME"] = "some-table";
    process.env["AWS_REGION"] = "eu-west-2";
    expect(() => realDeps()).not.toThrow();
  });

  it("refuses to start without a table rather than writing somewhere unnamed", () => {
    delete process.env["TABLE_NAME"];
    expect(() => realDeps()).toThrow(/Missing TABLE_NAME/);
  });
});

describe("what the package exposes", () => {
  it("exports the Lambda entry point from the package entry", async () => {
    const pkg = await import("../src/index.js");
    expect(typeof pkg.handler).toBe("function");
    expect(typeof pkg.categorise).toBe("function");
  });
});
