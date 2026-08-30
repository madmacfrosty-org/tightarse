/**
 * The existing labels, as entities.
 *
 * The migration's first step: every category in service today becomes an entity
 * with a stable id, and the label stays byte-identical so nothing visible
 * changes. Ids are readable slugs rather than opaque, because they appear in
 * rules, in stored rows and in any diff a human reads — `groceries` is
 * reviewable in a way a UUID is not.
 *
 * Renaming a label after this is a one-field edit rather than a rewrite of every
 * stored row, which is the whole point.
 */

import { CATEGORIES, type CategoryLabel } from "./taxonomy.js";
import type { Category, CategoryKind } from "./category.js";

/**
 * `Eating Out` -> `eating-out`, `Gifts & Charity` -> `gifts-charity`.
 *
 * `&` becomes a space rather than nothing, so `R&D` reads `r-d` and not `rd` —
 * an ampersand joins two words and dropping it silently welds them together.
 *
 * The trim removes a single dash at each end, because the run collapse above has
 * already reduced any sequence to one.
 */
export function slugFor(label: string): string {
  return label
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Kinds, assigned conservatively.
 *
 * Only `Income` and `Transfer` are anything other than spending, because those
 * two are unarguable. Two others are genuinely debatable and are left as
 * spending deliberately, since that is what the totals do today and changing a
 * kind changes what the household is told it spent:
 *
 *   Savings & Investments  money to your own savings account is a movement;
 *                          money into an external investment is not, and the
 *                          ledger cannot tell which from the transaction alone.
 *   Cash Withdrawal        the money has left the account but has not been
 *                          spent yet, and nothing here ever learns what it went
 *                          on.
 *
 * Both want deciding on purpose rather than by whoever writes the next line of
 * this file.
 */
const KINDS: Partial<Record<CategoryLabel, CategoryKind>> = {
  Income: "income",
  Transfer: "movement",
};

export const SEED_CATEGORIES: readonly Category[] = CATEGORIES.map((label) => ({
  id: slugFor(label),
  label,
  kind: KINDS[label] ?? "spending",
  taxonomy: "household" as const,
  retired: false,
}));

/**
 * The rules in service today, as versioned sets.
 *
 * The second migration step. Shipped patterns become `built-in`, seeded from
 * code so they stay reviewed through pull requests while the table becomes the
 * evaluation surface. The household's own become `household`, above them,
 * because a hand-written rule must never be outranked by one we shipped.
 *
 * Precedence runs low to high:
 *
 *   0  household   hand-written, authored, never regenerated
 *   2  built-in    shipped patterns
 *   3  provider    the provider's own transaction type
 *
 * 1 is left free deliberately: `assisted` — rules proposed for review — belongs
 * between the two, and renumbering a set after rules reference it is exactly the
 * churn explicit ordering exists to avoid.
 */

import { PROVIDER_RULES, RULES } from "./merchant-rules.js";
import type { CustomRule } from "./enrichment.js";
import type { Rule, RuleSet } from "./rules.js";

export const HOUSEHOLD_ORDER = 0;
export const BUILT_IN_ORDER = 2;
export const PROVIDER_ORDER = 3;

/**
 * A shipped merchant pattern, as a rule.
 *
 * `pattern.source` rather than the RegExp: a rule is data, and data has no
 * flags. Matching applies `i` itself, which is what these already carried.
 */
export function builtInRules(): Rule[] {
  return RULES.map((r) => ({
    matcher: { kind: "merchant" as const, pattern: r.pattern.source },
    contributes: { kind: "assert" as const, category: slugFor(r.category) },
    appliesTo: "debits" as const,
  }));
}

/**
 * The provider's own transaction type, as rules.
 *
 * Far more reliable than a description for these: an ATM withdrawal's
 * description is usually a location rather than a merchant.
 */
export function providerRules(): Rule[] {
  const rules: Rule[] = Object.entries(PROVIDER_RULES).map(
    ([value, label]) => ({
      matcher: { kind: "providerCategory" as const, value },
      contributes: { kind: "assert" as const, category: slugFor(label) },
      appliesTo: "debits" as const,
    }),
  );

  // Interest is Income when received and Fees & Charges when paid. Direction
  // decides, not the label — which is two rules over one matcher, and the
  // reason `appliesTo` has a `credits` option at all.
  rules.push(
    {
      matcher: { kind: "providerCategory", value: "INTEREST" },
      contributes: { kind: "assert", category: slugFor("Income") },
      appliesTo: "credits",
    },
    {
      matcher: { kind: "providerCategory", value: "INTEREST" },
      contributes: { kind: "assert", category: slugFor("Fees & Charges") },
      appliesTo: "debits",
    },
  );
  return rules;
}

/** The household's own rules, which name categories by label today. */
export function householdRules(custom: readonly CustomRule[]): Rule[] {
  return custom.map((r) => ({
    matcher: { kind: "merchant" as const, pattern: r.pattern },
    contributes: { kind: "assert" as const, category: slugFor(r.category) },
    // `all`, unlike the shipped patterns. A generic rule must not match credits
    // because no pattern can tell a refund from income — but somebody writing a
    // rule for their own employer knows precisely which it is, and that is the
    // one case where the author has context the pattern lacks.
    //
    // The first migration converted these as debits-only and lost 185 income
    // transactions their category, which is how this was found.
    appliesTo: "all" as const,
    ...(r.note === undefined ? {} : { note: r.note }),
  }));
}

export interface SeedOptions {
  readonly now: Date;
  readonly custom?: readonly CustomRule[] | undefined;
}

/**
 * Every set to write on a first migration.
 *
 * Proposed, not effective. A seed is a rule change like any other and goes
 * through the same door: proposed, looked at, decided. The household set will
 * need a person, because nothing derived may be auto-approved over an authored
 * one — which is right, since converting eighteen hand-written rules is worth
 * reading once.
 *
 * Version 1 throughout: these are the first versions of each set, not a
 * continuation of anything. The legacy single `RULES` item is left where it is —
 * it is the source being read, and deleting a source during a migration removes
 * the only way to check the result.
 */
export function seedRuleSets(options: SeedOptions): RuleSet[] {
  const createdAt = options.now.toISOString();
  const sets: RuleSet[] = [
    {
      setId: "built-in",
      version: 1,
      name: "Shipped patterns",
      order: BUILT_IN_ORDER,
      authored: false,
      status: "proposed" as const,
      rules: builtInRules(),
      createdAt,
    },
    {
      // NOT `provider`. That id is the sentinel meaning "no rule categorised
      // this, here is the payment rail" — synthesised at read time by
      // `providerCategorisation`, never stored, and read that way by the whole
      // stack: `summarise` marks it provisional, the dashboard greys it, and the
      // published contract documents it as "`provider` where nothing did".
      //
      // This set asserts REAL categories from the provider's own transaction
      // type. Sharing the name made `effectiveCategories` discard every one of
      // them as though nothing had matched, so an ATM withdrawal was
      // categorised as cash and then displayed as uncategorised.
      setId: "provider-types",
      version: 1,
      name: "Provider transaction types",
      order: PROVIDER_ORDER,
      authored: false,
      status: "proposed" as const,
      rules: providerRules(),
      createdAt,
    },
  ];

  const custom = options.custom ?? [];
  if (custom.length > 0) {
    sets.unshift({
      setId: "household",
      version: 1,
      name: "Hand-written",
      order: HOUSEHOLD_ORDER,
      // Authored: re-application never regenerates it. These are the only rules
      // here that cannot be rebuilt from code.
      authored: true,
      status: "proposed" as const,
      rules: householdRules(custom),
      createdAt,
    });
  }

  return sets;
}
