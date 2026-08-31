import { describe, it, expect } from "vitest";
import {
  AmountMatcherView,
  AppliedView,
  MerchantMatcherView,
  ProviderCategoryMatcherView,
  TransactionMatcherView,
  LeafMatcherView,
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
} from "../src/index.js";

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
  ["Matcher.pattern", MerchantMatcherView.shape.pattern, "Case-insensitive"],
  ["Matcher.value", ProviderCategoryMatcherView.shape.value, "coarse category"],
  ["Matcher.dedupKey", TransactionMatcherView.shape.dedupKey, "dedup key"],
  ["Matcher.min", AmountMatcherView.innerType().shape.min, "by size"],
  ["Matcher.max", AmountMatcherView.innerType().shape.max, "by size"],
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
  ["Proposal.proposed", ProposalResponse.shape.proposed, "absent on a preview"],
  ["Proposal.applied", ProposalResponse.shape.applied, "unless it was asked for"],
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
    expect(() => MatcherView.parse({ kind: "dayOfMonth", value: 15 })).toThrow();
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
    expect(MerchantMatcherView.shape.pattern.description).toContain("Case-insensitive");
  });

  it.each([
    [{ kind: "merchant", pattern: "somemart" }],
    [{ kind: "providerCategory", value: "DIRECT_DEBIT" }],
    [{ kind: "transaction", dedupKey: "d1" }],
    [{ kind: "amount", min: 90_00, max: 100_00 }],
  ])("accepts %o as one condition", (leaf) => {
    expect(LeafMatcherView.parse(leaf)).toEqual(leaf);
  });

  it("refuses an amount open at both ends, which is not a condition", () => {
    // It would match every transaction while looking like a filter.
    expect(() => LeafMatcherView.parse({ kind: "amount" })).toThrow();
    expect(LeafMatcherView.parse({ kind: "amount", min: 1 })).toEqual({ kind: "amount", min: 1 });
    expect(LeafMatcherView.parse({ kind: "amount", max: 1 })).toEqual({ kind: "amount", max: 1 });
  });

  it("accepts several conditions at once, and refuses one or none", () => {
    const two = {
      kind: "all",
      of: [
        { kind: "providerCategory", value: "DIRECT_DEBIT" },
        { kind: "amount", min: 90_00, max: 100_00 },
      ],
    };

    expect(MatcherView.parse(two)).toEqual(two);
    expect(() => MatcherView.parse({ kind: "all", of: [{ kind: "merchant", pattern: "x" }] })).toThrow();
    expect(() => MatcherView.parse({ kind: "all", of: [] })).toThrow();
  });

  it("does not nest, because nothing that builds one needs a tree", () => {
    expect(() =>
      MatcherView.parse({
        kind: "all",
        of: [
          { kind: "merchant", pattern: "a" },
          { kind: "all", of: [{ kind: "merchant", pattern: "b" }, { kind: "merchant", pattern: "c" }] },
        ],
      }),
    ).toThrow();
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

  it("gives every group the same shape, so a client reads them the same way", () => {
    // They share `EffectView` rather than carrying per-field descriptions: a
    // described wrapper is not the schema that was named, so it inlines and
    // the `$ref` points into another schema's properties instead.
    for (const group of ["gained", "lost", "recategorised", "unchanged", "outranked"] as const) {
      expect(Object.keys(PredictionView.shape[group].shape).sort()).toEqual([
        "entries",
        "merchants",
        "outgoing",
        "transactions",
        "truncated",
      ]);
    }
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

  it("says the versions are absent on a preview, so omission is not read as failure", () => {
    expect(ProposalResponse.shape.proposed.description).toContain("absent on a preview");
  });

  it("reports what applying did, in counts", () => {
    const applied = { scanned: 47, unchanged: 5, appended: 42, orphaned: 0, uncategorised: 3, conflicts: 0, inertRefines: 1 };

    expect(AppliedView.parse(applied)).toEqual(applied);
    expect(ProposalResponse.parse({ prediction, applied }).applied).toEqual(applied);
  });

  it("carries nothing about applying unless it happened", () => {
    expect(ProposalResponse.parse({ prediction }).applied).toBeUndefined();
    expect(ProposalResponse.shape.applied.description).toContain("unless it was asked for");
  });

  it("says what each count means, since several could be mistaken for each other", () => {
    expect(AppliedView.shape.appended.description).toContain("Categorisations written");
    expect(AppliedView.shape.orphaned.description).toContain("now no rule produces one");
    expect(AppliedView.shape.uncategorised.description).toContain("matched by nothing");
    expect(AppliedView.shape.unchanged.description).toContain("already stored");
    expect(AppliedView.shape.conflicts.description).toContain("two answers at once");
    expect(AppliedView.shape.inertRefines.description).toContain("nothing established");
  });
});
