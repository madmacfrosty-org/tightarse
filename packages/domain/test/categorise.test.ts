import { describe, it, expect } from "vitest";
import { categorise, BATCH_SIZE } from "../src/application/categorise.js";
import type { CategoriseDeps } from "../src/application/categorise.js";
import type { Candidate, Classification } from "../src/categorisation/taxonomy.js";
import type { TransactionEnrichment } from "../src/categorisation/enrichment.js";

/**
 * Categorising a backlog.
 *
 * The arithmetic of matching lives in merchant-rules; what matters here is the
 * sequence — rules written before the model is asked, each model batch written
 * before the next is requested, and "off" meaning off.
 */

const NOW = new Date("2026-03-01T09:00:00.000Z");
const RANGE = { from: "2026-01-01", to: "2026-03-01" };

const row = (dedupKey: string, description: string) => ({
  dedupKey,
  description,
  amount: -10_00,
  timestamp: "2026-02-01T00:00:00.000Z",
});

function ledgerWith(
  rows: ReadonlyArray<Record<string, unknown>>,
  enrichment: "off" | "rules" | "model" = "rules",
) {
  const written: TransactionEnrichment[] = [];
  return {
    written,
    ledger: {
      listToEnrich: async (_t: string, _r: unknown, limit?: number) =>
        limit === undefined ? [...rows] : rows.slice(0, limit),
      getCustomRules: async () => [],
      putEnrichment: async (e: TransactionEnrichment) => {
        written.push(e);
      },
      getSettings: async () => ({ tenantId: "frost", enrichment }) as never,
    },
  };
}

/** A classifier that answers everything it is given, recording each batch's size. */
function classifierAnswering(category: string) {
  const batches: number[] = [];
  return {
    batches,
    classifier: {
      producedBy: "categoriser@test-model",
      classify: async (candidates: readonly Candidate[]) => {
        batches.push(candidates.length);
        return {
          classifications: candidates.map((c) => ({
            dedupKey: c.dedupKey,
            category,
            confidence: 0.9,
          })) as Classification[],
          rejected: 0,
          missing: 0,
          inputTokens: 10,
          outputTokens: 5,
        };
      },
    },
  };
}

describe("what the household has chosen", () => {
  it("does nothing at all when enrichment is off", async () => {
    // Turning it off has to stop the schedule, or the setting is decorative.
    const { ledger, written } = ledgerWith([row("a", "TESCO STORES 3411")], "off");
    const report = await categorise({ ledger }, "frost", { range: RANGE, now: NOW });
    expect(report.skipped).toBe(true);
    expect(report.mode).toBe("off");
    expect(written).toHaveLength(0);
    // Nothing was read, so nothing can be reported as seen either.
    expect(report.assignments).toEqual([]);
    expect(report.candidates).toEqual([]);
  });

  it("defaults to rules for a household with no settings row", async () => {
    // A new household has no settings until someone saves some. Rules are free
    // and reproducible, so they are the safe default; defaulting to "model"
    // would spend money on a household that never asked, and defaulting to
    // "off" would leave the ledger uncategorised with nothing to show why.
    const { ledger, written } = ledgerWith([row("a", "TESCO STORES 3411")]);
    const report = await categorise(
      { ledger: { ...ledger, getSettings: async () => null } },
      "frost",
      { range: RANGE, now: NOW },
    );
    expect(report.mode).toBe("rules");
    expect(report.skipped).toBe(false);
    expect(written).toHaveLength(1);
  });

  it("lets an explicit mode override the setting, which is how an operator runs the model once", async () => {
    const { ledger } = ledgerWith([row("a", "NOT A KNOWN MERCHANT")], "off");
    const { classifier } = classifierAnswering("Groceries");
    const report = await categorise({ ledger, classifier }, "frost", {
      range: RANGE,
      now: NOW,
      mode: "model",
    });
    expect(report.skipped).toBe(false);
    expect(report.written).toBe(1);
  });
});

describe("rules before the model", () => {
  it("writes rule matches even when no classifier was supplied", async () => {
    // The schedule is exactly this: rules land daily, the model never runs.
    const { ledger, written } = ledgerWith([row("a", "TESCO STORES 3411")]);
    const report = await categorise({ ledger }, "frost", { range: RANGE, now: NOW });
    expect(report.matchedByRules).toBe(1);
    expect(report.written).toBe(1);
    expect(written[0]?.producedBy).not.toBe("categoriser@test-model");
  });

  it("asks the model only for what the rules could not place", async () => {
    const { ledger } = ledgerWith([row("a", "TESCO STORES 3411"), row("b", "ZZQX UNKNOWN 99")]);
    const { classifier, batches } = classifierAnswering("Other");
    const report = await categorise({ ledger, classifier }, "frost", {
      range: RANGE,
      now: NOW,
      mode: "model",
    });
    expect(report.matchedByRules).toBe(1);
    expect(batches).toEqual([1]);
    expect(report.written).toBe(2);
  });

  it("attributes each half to what produced it", async () => {
    // An enrichment a rule can reproduce for free is not the same as one that
    // cost a model call, and only producedBy says which.
    const { ledger, written } = ledgerWith([row("a", "TESCO STORES 3411"), row("b", "ZZQX UNKNOWN 99")]);
    const { classifier } = classifierAnswering("Other");
    await categorise({ ledger, classifier }, "frost", { range: RANGE, now: NOW, mode: "model" });
    const by = written.map((e) => e.producedBy);
    expect(by).toContain("categoriser@test-model");
    expect(by.filter((b) => b === "categoriser@test-model")).toHaveLength(1);
  });

  it("stays rules-only when the mode says model but nothing can classify", async () => {
    // The daily schedule supplies no classifier. A household set to "model"
    // should still get its rules applied rather than an error.
    const { ledger } = ledgerWith([row("a", "TESCO STORES 3411"), row("b", "ZZQX UNKNOWN 99")], "model");
    const report = await categorise({ ledger }, "frost", { range: RANGE, now: NOW });
    expect(report.written).toBe(1);
    expect(report.unmatched).toBe(1);
    expect(report.inputTokens).toBe(0);
  });
});

describe("not spending money it was not asked to spend", () => {
  it("never calls the classifier when the mode is rules, even though one was supplied", async () => {
    // The command line supplies a classifier whatever the mode is. A household
    // on "rules" must not be billed for a model call because the caller happened
    // to have one to hand.
    const { ledger } = ledgerWith([row("a", "TESCO STORES 3411"), row("b", "ZZQX UNKNOWN 99")], "rules");
    const { classifier, batches } = classifierAnswering("Other");
    const report = await categorise({ ledger, classifier }, "frost", { range: RANGE, now: NOW });
    expect(batches).toEqual([]);
    expect(report.unmatched).toBe(1);
    expect(report.inputTokens).toBe(0);
  });

  it("does not ask the model when the rules placed everything", async () => {
    // An empty backlog must not become a call with an empty batch: it costs a
    // request and its answer is definitionally nothing.
    const { ledger } = ledgerWith([row("a", "TESCO STORES 3411")]);
    const { classifier, batches } = classifierAnswering("Other");
    const report = await categorise({ ledger, classifier }, "frost", {
      range: RANGE,
      now: NOW,
      mode: "model",
    });
    expect(batches).toEqual([]);
    expect(report.written).toBe(1);
  });
});

describe("batching the model", () => {
  it("splits the backlog into batches and writes each before asking for the next", async () => {
    const rows = Array.from({ length: BATCH_SIZE + 3 }, (_, i) => row(`k${i}`, `ZZQX UNKNOWN ${i}`));
    const { ledger, written } = ledgerWith(rows);
    const seen: number[] = [];
    const classifier = {
      producedBy: "categoriser@test-model",
      classify: async (candidates: readonly Candidate[]) => {
        // What is already persisted when the next batch is requested. A run that
        // dies here must keep the batches it already paid for.
        seen.push(written.length);
        return {
          classifications: candidates.map((c) => ({ dedupKey: c.dedupKey, category: "Other", confidence: 0.5 })) as Classification[],
          rejected: 0,
          missing: 0,
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    };
    const report = await categorise({ ledger, classifier }, "frost", { range: RANGE, now: NOW, mode: "model" });
    expect(seen).toEqual([0, BATCH_SIZE]);
    expect(report.written).toBe(BATCH_SIZE + 3);
    expect(report.inputTokens).toBe(2);
  });

  it("carries rejected and missing counts back without inventing enrichments", async () => {
    const { ledger, written } = ledgerWith([row("a", "ZZQX UNKNOWN 1")]);
    const classifier = {
      producedBy: "categoriser@test-model",
      classify: async () => ({
        classifications: [] as Classification[],
        rejected: 1,
        missing: 1,
        inputTokens: 7,
        outputTokens: 2,
      }),
    };
    const report = await categorise({ ledger, classifier }, "frost", { range: RANGE, now: NOW, mode: "model" });
    expect(report).toMatchObject({ rejected: 1, missing: 1, written: 0, outputTokens: 2 });
    expect(written).toHaveLength(0);
  });
});

describe("a dry run", () => {
  it("counts what it would assign and writes nothing", async () => {
    const { ledger, written } = ledgerWith([row("a", "TESCO STORES 3411"), row("b", "ZZQX UNKNOWN 99")]);
    const { classifier } = classifierAnswering("Other");
    const report = await categorise({ ledger, classifier }, "frost", {
      range: RANGE,
      now: NOW,
      mode: "model",
      dryRun: true,
    });
    expect(written).toHaveLength(0);
    expect(report.written).toBe(0);
    // Still reports what it saw, which is the entire point of a dry run.
    expect(report.assignments).toHaveLength(2);
    expect([...report.tally.values()].reduce((a, b) => a + b, 0)).toBe(2);
  });
});

describe("the limit", () => {
  it("passes a limit through to the backlog read", async () => {
    const rows = [row("a", "TESCO STORES 3411"), row("b", "TESCO STORES 3411")];
    const { ledger } = ledgerWith(rows);
    const report = await categorise({ ledger }, "frost", { range: RANGE, now: NOW, limit: 1 });
    expect(report.backlog).toBe(1);
  });
});
