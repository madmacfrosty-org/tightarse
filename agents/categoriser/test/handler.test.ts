import { describe, it, expect, vi, beforeEach } from "vitest";
import { categorise, realDeps, type CategoriseDeps } from "../src/handler";

/**
 * The scheduled run.
 *
 * This runs unattended and writes to the ledger. What matters is that it applies
 * the whole range rather than a lookback, that it reports what it did, and that
 * it refuses to start without a table rather than writing somewhere unnamed.
 */

const listRange = vi.fn();
const listRuleSets = vi.fn();
const listCategorisationHistory = vi.fn();
const putCategorisation = vi.fn();
const getSettings = vi.fn();

const deps = (over: Partial<CategoriseDeps> = {}): CategoriseDeps => ({
  ledger: { listRange, listRuleSets, putCategorisation, listCategorisationHistory, getSettings } as never,
  tenantId: "frost",
  environment: "test",
  ...over,
});

const ruleSet = (rules: unknown[]) => ({
  setId: "built-in",
  version: 1,
  name: "built-in",
  order: 2,
  authored: false,
  rules,
  createdAt: "2026-01-01T00:00:00.000Z",
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  listRange.mockReset().mockResolvedValue({ transactions: [], enrichments: [], categorisations: [] });
  listRuleSets.mockReset().mockResolvedValue([]);
  putCategorisation.mockReset().mockResolvedValue(undefined);
  getSettings.mockReset().mockResolvedValue({ enrichment: "rules" });
});

describe("what the schedule does", () => {
  it("applies the whole ledger, not a lookback", async () => {
    // Scope cannot be narrowed by a changed rule's footprint: a new refine
    // changes the outcome for transactions a DIFFERENT rule asserted, so
    // anything narrower is a guess about which rows a change can reach.
    await categorise(deps());
    const [, range] = listRange.mock.calls[0] as [string, { from: string; to: string }];
    expect(range.from).toBe("2000-01-01");
  });

  it("lets an event narrow the window for a one-off", async () => {
    await categorise(deps(), { from: "2026-01-01", to: "2026-02-01" });
    const [, range] = listRange.mock.calls[0] as [string, { from: string; to: string }];
    expect(range).toEqual({ from: "2026-01-01", to: "2026-02-01" });
  });

  it("reads the household it was given and not a hardcoded one", async () => {
    await categorise(deps({ tenantId: "someone-else" }));
    expect(listRange.mock.calls[0]?.[0]).toBe("someone-else");
  });

  it("writes a categorisation for what the rules place", async () => {
    // The main path. Without this, a run that silently did nothing every
    // morning would still exit cleanly — which is the decay this job exists to
    // stop.
    listRuleSets.mockResolvedValue([
      ruleSet([
        {
          matcher: { kind: "merchant", pattern: "somemart" },
          contributes: { kind: "assert", category: "groceries" },
          appliesTo: "debits",
        },
      ]),
    ]);
    listRange.mockResolvedValue({
      transactions: [
        {
          dedupKey: "d1",
          description: "SOMEMART SUPERSTORE",
          amount: -12_00,
          currency: "GBP",
          timestamp: "2026-02-01T00:00:00.000Z",
        },
      ],
      enrichments: [],
      categorisations: [],
    });
    const report = await categorise(deps());
    expect(putCategorisation).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ scanned: 1, appended: 1 });
  });

  it("reports counts and never a description", async () => {
    // This output goes to CloudWatch. A description is a merchant, a person's
    // name, or an employer.
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: unknown) => {
      lines.push(String(l));
    });
    listRange.mockResolvedValue({
      transactions: [
        { dedupKey: "d1", description: "A VERY PRIVATE MERCHANT", amount: -1_00, currency: "GBP", timestamp: "2026-02-01T00:00:00.000Z" },
      ],
      enrichments: [],
      categorisations: [],
    });
    await categorise(deps());
    expect(lines.join(" ")).not.toContain("PRIVATE");
    // The metric line comes first, so find the report rather than assuming a
    // position — and both are checked for the description above.
    const report = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((o) => "scanned" in o);
    expect(report).toMatchObject({ tenantId: "frost", scanned: 1 });
  });
});

describe("the household's off switch", () => {
  it("does nothing at all when enrichment is off", async () => {
    // It predates the rule-set model, and applying rules without checking it
    // would silently take away a control somebody set.
    getSettings.mockResolvedValue({ enrichment: "off" });
    const report = await categorise(deps());
    expect(listRange).not.toHaveBeenCalled();
    expect(putCategorisation).not.toHaveBeenCalled();
    expect(report.scanned).toBe(0);
  });

  it("runs for a household with no settings recorded", async () => {
    getSettings.mockResolvedValue(null);
    await categorise(deps());
    expect(listRange).toHaveBeenCalled();
  });
});

describe("what it reads from the environment", () => {
  it("defaults the household and the metric dimension", () => {
    // An undefined dimension emits under "undefined" and no alarm matches it.
    //
    // AWS_REGION is deleted deliberately: it is set in CI and in any shell that
    // has run an aws command, so leaving it inherited means this fallback is
    // exercised or not depending on who ran the tests.
    process.env["TABLE_NAME"] = "some-table";
    delete process.env["TENANT_ID"];
    delete process.env["ENVIRONMENT"];
    delete process.env["AWS_REGION"];
    expect(realDeps()).toMatchObject({ tenantId: "frost", environment: "dev" });
  });

  it("uses AWS_REGION when the environment sets one", () => {
    process.env["TABLE_NAME"] = "some-table";
    process.env["AWS_REGION"] = "eu-west-2";
    expect(() => realDeps()).not.toThrow();
  });

  it("refuses to start without a table rather than writing somewhere unnamed", () => {
    delete process.env["TABLE_NAME"];
    expect(() => realDeps()).toThrow(/TABLE_NAME/);
  });
});

describe("the package entry", () => {
  it("exports the Lambda entry point", async () => {
    // The stack points at this module. An export renamed without the stack
    // following is a deploy that succeeds and a schedule that never fires.
    const entry: Record<string, unknown> = await import("../src/index.js");
    expect(typeof entry["handler"]).toBe("function");
    expect(typeof entry["categorise"]).toBe("function");
  });
});
