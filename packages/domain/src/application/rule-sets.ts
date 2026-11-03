/**
 * The rules as they stand, so a household can see what is deciding its
 * categories.
 *
 * Everything that changes rules already exists — `proposeRules` takes whole
 * sets and previews what they would do, and the CLI can list them from a
 * terminal with the table name to hand. What was missing is reading them from
 * the dashboard, which makes the write path much less useful than it looks: to
 * edit a set you must first send the set as it would be, and nothing told you
 * what it currently is.
 *
 * ## Precedence is the household's, not the set's
 *
 * A set carries no rank. It cannot: a set shared between households ranks
 * differently for each, so where it sits is a property of the decision to use
 * it (#121). The adoption list is that decision, in order, earliest winning.
 *
 * Which means a set can exist and not apply. That is the point of the model —
 * a shared set sitting in the table is an offer rather than an instruction —
 * and it is invisible in every other view. Reported here as `adopted: false`
 * with no precedence, because "these rules exist and do nothing" is exactly
 * the kind of thing somebody debugging a category needs told.
 */

import { orderedSets } from "../categorisation/adoption.js";
import { parseRuleSets, type Rule, type RuleSetStatus } from "../categorisation/rules.js";
import type { LedgerReads } from "../ports/outbound/index.js";

export interface RuleSetsDeps {
  readonly ledger: Pick<LedgerReads, "listRuleSets" | "getAdoptions">;
}

/** One set, with where it stands for this household. */
export interface RuleSetView {
  readonly setId: string;
  readonly name: string;
  readonly version: number;
  readonly status: RuleSetStatus;
  /** Whether a person wrote it. Gates automatic approval, nothing else. */
  readonly authored: boolean;
  /** Whether this household has adopted it. An unadopted set applies to nothing. */
  readonly adopted: boolean;
  /**
   * Position in the household's adoption order, lower winning. Absent when the
   * set is not adopted, rather than a sentinel: there is no rank to report, and
   * a number would invite a comparison that means nothing.
   */
  readonly precedence?: number | undefined;
  readonly rules: readonly Rule[];
  readonly createdAt: string;
  readonly createdBy?: string | undefined;
}

/**
 * Every set this household has, adopted first and in the order they apply.
 *
 * Unadopted sets follow, by id, so the listing is stable — two reads in a row
 * must not reorder a screen somebody is reading.
 *
 * Tolerates a set that will not parse by leaving it out, which is the policy
 * everywhere rules are read: a malformed set matches nothing during
 * application, so showing nothing for it is consistent rather than convenient.
 * The count of what was dropped is reported, because a set that silently
 * vanishes from this screen is how somebody concludes a rule was deleted.
 */
export async function ruleSets(
  deps: RuleSetsDeps,
  tenantId: string,
): Promise<{ sets: RuleSetView[]; unreadable: number }> {
  const [rows, adoptions] = await Promise.all([
    deps.ledger.listRuleSets(tenantId),
    deps.ledger.getAdoptions(tenantId),
  ]);

  const parsed = parseRuleSets(rows);
  const adoptedOrder = orderedSets(adoptions, parsed);
  const precedenceOf = new Map(adoptedOrder.map((s, i) => [s.setId, i]));

  const view = (s: (typeof parsed)[number]): RuleSetView => {
    const precedence = precedenceOf.get(s.setId);
    return {
      setId: s.setId,
      name: s.name,
      version: s.version,
      status: s.status,
      authored: s.authored,
      adopted: precedence !== undefined,
      ...(precedence !== undefined ? { precedence } : {}),
      rules: s.rules,
      createdAt: s.createdAt,
      ...(s.createdBy !== undefined ? { createdBy: s.createdBy } : {}),
    };
  };

  const unadopted = parsed
    .filter((s) => !precedenceOf.has(s.setId))
    .sort((a, b) => a.setId.localeCompare(b.setId));

  return {
    sets: [...adoptedOrder.map(view), ...unadopted.map(view)],
    unreadable: rows.length - parsed.length,
  };
}
