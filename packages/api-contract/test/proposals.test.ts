import { describe, it, expect } from "vitest";
import {
  ChangeView,
  ContributionView,
  EffectView,
  IntroducedConflictView,
  MatcherView,
  PredictionView,
  ProposalRequest,
  ProposalResponse,
  ProposedRuleSetView,
  RuleView,
} from "../src/index";

/**
 * What the proposals endpoint promises.
 *
 * These schemas mirror the domain's rules rather than importing them, so the
 * thing worth testing is that the mirror stays honest about the parts a client
 * can get wrong silently: what a matcher may be, which direction a rule applies
 * to, and whether a result was truncated.
 *
 * Merchants here are invented. Real ones are household data and do not go in
 * files.
 */

const rule = {
  matcher: { kind: "merchant" as const, pattern: "somemart" },
  contributes: { kind: "assert" as const, category: "groceries" },
  appliesTo: "debits" as const,
};

const set = {
  setId: "household",
  version: 3,
  name: "household",
  order: 0,
  authored: true,
  rules: [rule],
};

const effect = { transactions: 2, outgoing: 20_00, merchants: 1, entries: [], truncated: false };

/**
 * Every described field, and what its description has to keep saying.
 *
 * A table rather than assertions scattered through the file: a description is
 * part of the contract — it is what a client author reads instead of the
 * handler — and one that quietly empties is indistinguishable from one that was
 * never written.
 */
const DESCRIBED: Array<[string, { description?: string | undefined }, string]> = [
  ["Matcher.pattern", MatcherView.options[0].shape.pattern, "Case-insensitive"],
  ["Matcher.value", MatcherView.options[1].shape.value, "coarse category"],
  ["Matcher.dedupKey", MatcherView.options[2].shape.dedupKey, "dedup key"],
  ["Contribution.assert", ContributionView.options[0].shape.category, "Establishes"],
  ["Contribution.refine", ContributionView.options[1].shape.category, "Inert"],
  ["Rule.appliesTo", RuleView.shape.appliesTo, "Credits are excluded"],
  ["ProposedRuleSet.version", ProposedRuleSetView.shape.version, "higher than the current"],
  ["ProposedRuleSet.order", ProposedRuleSetView.shape.order, "Lower wins"],
  ["ProposedRuleSet.authored", ProposedRuleSetView.shape.authored, "never whether it may be proposed"],
  ["ProposalRequest.sets", ProposalRequest.shape.sets, "left out are unchanged"],
  ["ProposalRequest.because", ProposalRequest.shape.because, "carried onto the stored version"],
  ["Change.from", ChangeView.shape.from, "absent when nothing matched"],
  ["Change.to", ChangeView.shape.to, "leaves it uncategorised"],
  ["Effect.outgoing", EffectView.shape.outgoing, "across this group"],
  ["Effect.merchants", EffectView.shape.merchants, "escaped"],
  ["Effect.entries", EffectView.shape.entries, "truncated where"],
  ["Effect.truncated", EffectView.shape.truncated, "Never truncated silently"],
  ["Conflict.categories", IntroducedConflictView.shape.categories, "would claim at once"],
  ["Conflict.example", IntroducedConflictView.shape.example, "would happen on"],
  ["Prediction.gained", PredictionView.shape.gained, "Uncategorised before"],
  ["Prediction.lost", PredictionView.shape.lost, "almost never intended"],
  ["Prediction.recategorised", PredictionView.shape.recategorised, "look hardest at"],
  ["Prediction.unchanged", PredictionView.shape.unchanged, "agreed with what was there"],
  ["Prediction.outranked", PredictionView.shape.outranked, "lost to a higher-precedence"],
  ["Proposal.proposed", ProposalResponse.shape.proposed, "absent on a dry run"],
];

describe("what the contract says out loud", () => {
  it.each(DESCRIBED)("%s still says what it means", (_name, schema, fragment) => {
    expect(schema.description ?? "").toContain(fragment);
  });

  it("says something different about each field, so none is a copy of another", () => {
    const said = DESCRIBED.map(([, schema]) => schema.description);
    expect(new Set(said).size).toBe(DESCRIBED.length);
  });
});

describe("what a rule may match on", () => {
  it.each([
    [{ kind: "merchant", pattern: "somemart" }],
    [{ kind: "providerCategory", value: "DIRECT_DEBIT" }],
    [{ kind: "transaction", dedupKey: "d1" }],
  ])("accepts %o", (matcher) => {
    expect(MatcherView.parse(matcher)).toEqual(matcher);
  });

  it("refuses a matcher kind the domain does not have", () => {
    expect(() => MatcherView.parse({ kind: "amount", value: 500 })).toThrow();
  });

  it.each([
    ["merchant", { kind: "merchant" }],
    ["providerCategory", { kind: "providerCategory" }],
    ["transaction", { kind: "transaction" }],
  ])("refuses a %s matcher with nothing to match on", (_kind, matcher) => {
    expect(() => MatcherView.parse(matcher)).toThrow();
  });

  it.each([
    [{ kind: "merchant", pattern: "" }],
    [{ kind: "providerCategory", value: "" }],
    [{ kind: "transaction", dedupKey: "" }],
  ])("refuses %o, which would match everything or nothing", (matcher) => {
    expect(() => MatcherView.parse(matcher)).toThrow();
  });

  it("says a pattern is case-insensitive, which a client cannot infer", () => {
    const merchant = MatcherView.options[0];
    expect(merchant.shape.pattern.description).toContain("Case-insensitive");
  });

  it.each([
    [0, ["kind", "pattern"]],
    [1, ["kind", "value"]],
    [2, ["kind", "dedupKey"]],
  ])("option %i carries exactly the fields that kind needs", (i, fields) => {
    // An option that quietly loses its fields still parses — zod strips unknown
    // keys rather than complaining — so the shape has to be asserted directly.
    expect(Object.keys(MatcherView.options[i]!.shape).sort()).toEqual([...fields].sort());
  });

  it("offers exactly the three kinds the domain has", () => {
    expect(MatcherView.options).toHaveLength(3);
    expect(MatcherView.options.map((o) => o.shape.kind.value)).toEqual([
      "merchant",
      "providerCategory",
      "transaction",
    ]);
  });
});

describe("what a rule contributes", () => {
  it.each(["assert", "refine"])("accepts %s", (kind) => {
    expect(ContributionView.parse({ kind, category: "fuel" })).toEqual({ kind, category: "fuel" });
  });

  it("refuses a contribution kind the domain does not have", () => {
    expect(() => ContributionView.parse({ kind: "remove", category: "fuel" })).toThrow();
    expect(() => ContributionView.parse({ kind: "assert", category: "" })).toThrow();
  });

  it.each([
    [0, "assert"],
    [1, "refine"],
  ])("option %i is %s, carrying only a category", (i, kind) => {
    expect(ContributionView.options[i]!.shape.kind.value).toBe(kind);
    expect(Object.keys(ContributionView.options[i]!.shape).sort()).toEqual(["category", "kind"]);
  });

  it("offers exactly the two contributions the fold understands", () => {
    expect(ContributionView.options).toHaveLength(2);
  });

  it("warns that a refine with nothing established does nothing", () => {
    // The trap that cost 98 transactions when it was tried on real data: a
    // qualifier whose assert never fires is silently inert, not an error.
    expect(ContributionView.options[1].shape.category.description).toContain("Inert");
  });
});

describe("what a rule promises", () => {
  it("accepts a rule with a direction and an optional note", () => {
    expect(RuleView.parse({ ...rule, note: "why" })).toMatchObject({ note: "why" });
    expect(RuleView.parse(rule).note).toBeUndefined();
  });

  it.each(["debits", "credits", "all"])("accepts a rule applying to %s", (appliesTo) => {
    expect(RuleView.parse({ ...rule, appliesTo }).appliesTo).toBe(appliesTo);
  });

  it("refuses a direction it does not know", () => {
    expect(() => RuleView.parse({ ...rule, appliesTo: "outgoing" })).toThrow();
  });

  it("says credits are excluded unless asked for, which is the sign convention in miniature", () => {
    expect(RuleView.shape.appliesTo.description).toContain("Credits are excluded");
  });
});

describe("what a proposed set promises", () => {
  it("accepts a set with its version and precedence", () => {
    expect(ProposedRuleSetView.parse(set)).toEqual(set);
  });

  it("says lower order wins, because the opposite is the natural guess", () => {
    expect(ProposedRuleSetView.shape.order.description).toContain("Lower wins");
  });

  it("says `authored` gates approval and not proposing", () => {
    expect(ProposedRuleSetView.shape.authored.description).toContain("never whether it may be proposed");
  });

  it("refuses a negative version", () => {
    expect(() => ProposedRuleSetView.parse({ ...set, version: -1 })).toThrow();
  });
});

describe("the request", () => {
  it("carries the sets as they would be, and why", () => {
    expect(ProposalRequest.parse({ sets: [set], because: "conflict" })).toMatchObject({ because: "conflict" });
  });

  it("refuses a proposal that proposes nothing", () => {
    expect(() => ProposalRequest.parse({ sets: [] })).toThrow();
  });

  it("says sets left out are unchanged, so a caller need not echo the world", () => {
    expect(ProposalRequest.shape.sets.description).toContain("left out are unchanged");
  });
});

describe("the prediction", () => {
  it("reports all five outcomes and the conflicts it would introduce", () => {
    const prediction = {
      gained: effect,
      lost: effect,
      recategorised: effect,
      unchanged: effect,
      outranked: effect,
      introducedConflicts: [],
      scanned: 10,
    };

    expect(PredictionView.parse(prediction)).toEqual(prediction);
  });

  it("names recategorised as the number to look hardest at", () => {
    expect(PredictionView.shape.recategorised.description).toContain("look hardest at");
  });

  it("says lost is almost never intended", () => {
    expect(PredictionView.shape.lost.description).toContain("almost never intended");
  });

  it("requires truncation to be declared, never silent", () => {
    expect(EffectView.shape.truncated.description).toContain("Never truncated silently");
    expect(() => EffectView.parse({ ...effect, truncated: undefined })).toThrow();
  });

  it("counts distinct descriptions, which is how a pattern that escaped is spotted", () => {
    expect(EffectView.shape.merchants.description).toContain("escaped");
  });

  it("carries what each transaction moved from and to", () => {
    const change = { dedupKey: "d1", description: "SOMEMART 118", from: "groceries", to: "fuel" };
    expect(ChangeView.parse(change)).toEqual(change);
    expect(ChangeView.parse({ dedupKey: "d1", description: "X" }).from).toBeUndefined();
  });

  it("names a conflict it would create, with somewhere to look", () => {
    const c = { setId: "household", categories: ["a", "b"], transactions: 2, example: "SOMEMART 118" };
    expect(IntroducedConflictView.parse(c)).toEqual(c);
  });
});

describe("the response", () => {
  const prediction = {
    gained: effect, lost: effect, recategorised: effect, unchanged: effect, outranked: effect,
    introducedConflicts: [], scanned: 10,
  };

  it("names what it wrote", () => {
    const r = ProposalResponse.parse({ prediction, proposed: [{ setId: "household", version: 3 }] });
    expect(r.proposed).toEqual([{ setId: "household", version: 3 }]);
  });

  it("writes nothing on a dry run, and says so by omission", () => {
    expect(ProposalResponse.parse({ prediction }).proposed).toBeUndefined();
  });

  it("says the versions are absent on a dry run, so omission is not read as failure", () => {
    expect(ProposalResponse.shape.proposed.description).toContain("absent on a dry run");
  });
});
