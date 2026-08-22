import { describe, it, expect, vi } from "vitest";
import type { CustomRule } from "../src/index.js";
import { compileCustom } from "../src/categorisation/merchant-rules.js";
import { prepare, writeRuleEnrichments } from "../src/categorisation/categorising.js";

/**
 * The rules half of categorisation.
 *
 * Shared by the scheduled Lambda and the operator CLI, and previously tested only
 * through the Lambda — so the thing both paths depend on was covered by one
 * caller's happy path. Two implementations of this would drift silently, which is
 * how a sign convention survived five years of wrong totals.
 */

const range = { from: "2026-03-01", to: "2026-03-31" };

function fakeLedger(rows: Array<Record<string, unknown>>, custom: CustomRule[] = []) {
  const written: unknown[] = [];
  return {
    written,
    ledger: {
      listToEnrich: vi.fn(async () => rows),
      getCustomRules: vi.fn(async () => custom),
      putEnrichment: vi.fn(async (e: unknown) => void written.push(e)),
    },
  };
}

const row = (over: Record<string, unknown> = {}) => ({
  dedupKey: "d1",
  description: "TESCO STORES 3421",
  amount: -12_50,
  currency: "GBP",
  timestamp: "2026-03-02T00:00:00Z",
  ...over,
});

describe("reading the backlog", () => {
  it("asks the ledger only for what needs enriching, within the range", async () => {
    const { ledger } = fakeLedger([]);
    await prepare(ledger as never, "frost", range, 60);
    expect(ledger.listToEnrich).toHaveBeenCalledWith("frost", range, 60);
  });

  it("matches a known merchant without reaching a model", async () => {
    const { ledger } = fakeLedger([row()]);
    const out = await prepare(ledger as never, "frost", range);
    expect(out.classifications).toEqual([{ dedupKey: "d1", category: "Groceries" }]);
    expect(out.unmatched).toEqual([]);
  });

  it("leaves what it does not recognise for the model, rather than guessing", async () => {
    const { ledger } = fakeLedger([row({ description: "SOMETHING UNFAMILIAR" })]);
    const out = await prepare(ledger as never, "frost", range);
    expect(out.classifications).toEqual([]);
    expect(out.unmatched).toHaveLength(1);
  });

  it("defaults a missing description and currency rather than passing undefined on", async () => {
    // A half-written row must not become the string "undefined" in a prompt, or
    // NaN in an amount the model is asked to reason about.
    const { ledger } = fakeLedger([{ dedupKey: "d9", timestamp: "2026-03-02T00:00:00Z" }]);
    const out = await prepare(ledger as never, "frost", range);
    expect(out.candidates[0]).toMatchObject({ description: "", amount: 0, currency: "GBP" });
  });

  it("carries the provider's own category when there is one, and omits it when not", async () => {
    const { ledger } = fakeLedger([row({ providerCategory: "ATM" }), row({ dedupKey: "d2" })]);
    const out = await prepare(ledger as never, "frost", range);
    expect(out.candidates[0]).toHaveProperty("providerCategory", "ATM");
    expect(out.candidates[1]).not.toHaveProperty("providerCategory");
  });

  it("counts the household's own rules, which live in the table not the repo", async () => {
    // The repo is public. A rule naming where this household shops would publish
    // exactly what the fixtures exist to keep out.
    const custom: CustomRule[] = [
      { pattern: "SOMETHING UNFAMILIAR", category: "Shopping", addedAt: "2026-01-01T00:00:00.000Z" },
    ];
    const { ledger } = fakeLedger([row({ description: "SOMETHING UNFAMILIAR" })], custom);
    const out = await prepare(ledger as never, "frost", range);
    expect(out.customRuleCount).toBe(1);
    expect(out.classifications).toHaveLength(1);
  });
});

describe("compiling the household's own rules", () => {
  it("ignores one naming a category outside the taxonomy", () => {
    // Free-form categories make aggregation meaningless, so an unknown one is
    // dropped rather than admitted.
    expect(compileCustom([
      { pattern: "X", category: "Invented", addedAt: "2026-01-01T00:00:00.000Z" } as never,
    ])).toEqual([]);
  });

  it("ignores one that is not a valid regular expression", () => {
    // Typed by a person at a command line. An unbalanced bracket must not take
    // the whole categorisation run down with it.
    expect(compileCustom([
      { pattern: "([unclosed", category: "Shopping", addedAt: "2026-01-01T00:00:00.000Z" },
    ])).toEqual([]);
  });

  it("compiles a good one case-insensitively", () => {
    const [rule] = compileCustom([
      { pattern: "corner shop", category: "Groceries", addedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(rule!.pattern.test("CORNER SHOP LTD")).toBe(true);
    expect(rule!.category).toBe("Groceries");
  });
});

describe("writing what the rules matched", () => {
  it("writes one enrichment per classification, keyed to the transaction", async () => {
    const { ledger, written } = fakeLedger([row()]);
    const prepared = await prepare(ledger as never, "frost", range);
    const out = await writeRuleEnrichments(ledger as never, "frost", prepared, "2026-03-03T00:00:00.000Z");
    expect(out.written).toBe(1);
    expect(written[0]).toMatchObject({
      tenantId: "frost",
      dedupKey: "d1",
      category: "Groceries",
      timestamp: "2026-03-02T00:00:00Z",
    });
  });

  it("tallies by category, so a run says what it actually did", async () => {
    const { ledger } = fakeLedger([row(), row({ dedupKey: "d2", description: "COSTA COFFEE" })]);
    const prepared = await prepare(ledger as never, "frost", range);
    const out = await writeRuleEnrichments(ledger as never, "frost", prepared);
    expect(out.tally.get("Groceries")).toBe(1);
    expect(out.tally.get("Eating Out")).toBe(1);
  });

  it("skips a classification whose transaction vanished between listing and writing", async () => {
    // putEnrichment requires the transaction to exist — it is a TransactWriteItems
    // carrying a ConditionCheck — so writing one without a timestamp would fail
    // the whole batch for a row somebody deleted mid-run.
    const { ledger, written } = fakeLedger([row()]);
    const prepared = await prepare(ledger as never, "frost", range);
    const orphaned = { classifications: prepared.classifications, timestamps: new Map<string, string>() };
    const out = await writeRuleEnrichments(ledger as never, "frost", orphaned);
    expect(out.written).toBe(0);
    expect(written).toEqual([]);
  });

  it("writes nothing when nothing matched", async () => {
    const { ledger, written } = fakeLedger([row({ description: "SOMETHING UNFAMILIAR" })]);
    const prepared = await prepare(ledger as never, "frost", range);
    const out = await writeRuleEnrichments(ledger as never, "frost", prepared);
    expect(out.written).toBe(0);
    expect(written).toEqual([]);
  });
});
