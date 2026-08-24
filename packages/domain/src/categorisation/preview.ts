/**
 * What a proposed change to the rules would actually do to a ledger.
 *
 * Reach is not enough. A household rule outranks the built-in and provider sets,
 * so generalising a pattern can rewrite categorisations that were already
 * correct — and re-application makes that silent. Someone approving a rule needs
 * to see the transactions it would *take* as clearly as the ones it would win.
 *
 * Computed by evaluating the corpus twice, before and after, and diffing the
 * answers. Deliberately not by reasoning about precedence: a second
 * implementation of who-wins is a second thing to keep in step with `evaluate`,
 * and the first time they disagreed, a preview would promise one thing and
 * application would do another. Running the real evaluator makes that
 * impossible.
 *
 * Pure. The corpus arrives as an argument, and nothing here writes.
 */

import { evaluate } from "./evaluate.js";
import type { RuleSet } from "./rules.js";
import type { CategoryId } from "./category.js";
import type { Candidate } from "./taxonomy.js";

/** One transaction whose answer the proposal touches. */
export interface Change {
  readonly dedupKey: string;
  readonly description: string;
  /** The category before, absent when nothing matched. */
  readonly from?: CategoryId | undefined;
  /** The category after, absent when the proposal leaves it uncategorised. */
  readonly to?: CategoryId | undefined;
}

/** A group of transactions the proposal affects the same way. */
export interface Effect {
  readonly transactions: number;
  /** Money that left the household, positive minor units. */
  readonly outgoing: number;
  /**
   * Distinct descriptions.
   *
   * The number that says whether a pattern has escaped. Four hundred
   * transactions at one merchant is narrow and probably right; four hundred
   * across two hundred merchants is a rule that got away, and a count of
   * transactions alone cannot tell those apart.
   */
  readonly merchants: number;
  /**
   * Every transaction in the group.
   *
   * Whole, not sampled: the caller decides what to show, and a preview that
   * quietly dropped the inconvenient half would be worse than none. Callers
   * sending this over a wire should truncate deliberately.
   */
  readonly entries: readonly Change[];
}

/** A set that would start claiming two answers at once. */
export interface IntroducedConflict {
  readonly setId: string;
  readonly categories: readonly CategoryId[];
  readonly transactions: number;
  /** One description it happens on, for a human deciding which rule is wrong. */
  readonly example: string;
}

export interface Preview {
  /** Uncategorised before, categorised after. The gain being shopped for. */
  readonly gained: Effect;
  /**
   * Categorised before, uncategorised after.
   *
   * Usually means the proposal introduced a conflict, because a set claiming two
   * answers produces none. Almost never what anyone intended.
   */
  readonly lost: Effect;
  /** One category before, a different one after. The number to look hardest at. */
  readonly recategorised: Effect;
  /** The proposal matched and agreed with what was already there. */
  readonly unchanged: Effect;
  /**
   * The proposal matched and lost.
   *
   * A higher-precedence set — an override, usually — answers first. Shown
   * because a rule that silently does nothing is otherwise indistinguishable
   * from one that works.
   */
  readonly outranked: Effect;
  readonly introducedConflicts: readonly IntroducedConflict[];
  readonly scanned: number;
}

interface Tally {
  transactions: number;
  outgoing: number;
  merchants: Set<string>;
  entries: Change[];
}

const emptyTally = (): Tally => ({ transactions: 0, outgoing: 0, merchants: new Set(), entries: [] });

function record(tally: Tally, candidate: Candidate, change: Change): void {
  tally.transactions += 1;
  if (candidate.amount < 0) tally.outgoing += -candidate.amount;
  tally.merchants.add(candidate.description);
  tally.entries.push(change);
}

const settle = (tally: Tally): Effect => ({
  transactions: tally.transactions,
  outgoing: tally.outgoing,
  merchants: tally.merchants.size,
  entries: tally.entries,
});

/**
 * Which sets the proposal changes.
 *
 * By version, because a proposal *is* a new version of a set — that is how rule
 * changes are stored, so nothing here has to guess at deep equality. A caller
 * that edits rules without advancing the version is lying about what it did, and
 * the preview will believe it.
 */
function proposedSetIds(before: readonly RuleSet[], after: readonly RuleSet[]): Set<string> {
  const versions = new Map(before.map((s) => [s.setId, s.version]));
  return new Set(after.filter((s) => versions.get(s.setId) !== s.version).map((s) => s.setId));
}

/**
 * Diff two rule set arrangements over a corpus.
 *
 * Two evaluations per transaction. That is twice the work of applying the rules,
 * which for one household is a fraction of a second, and it buys a preview that
 * cannot disagree with the application that follows it.
 */
export function preview(
  before: readonly RuleSet[],
  after: readonly RuleSet[],
  corpus: readonly Candidate[],
): Preview {
  const proposed = proposedSetIds(before, after);

  const gained = emptyTally();
  const lost = emptyTally();
  const recategorised = emptyTally();
  const unchanged = emptyTally();
  const outranked = emptyTally();
  const conflicts = new Map<string, { setId: string; categories: CategoryId[]; transactions: number; example: string }>();

  for (const candidate of corpus) {
    const was = evaluate(before, candidate);
    const now = evaluate(after, candidate);
    const from = was.effective?.category;
    const to = now.effective?.category;
    const change: Change = { dedupKey: candidate.dedupKey, description: candidate.description, from, to };

    // Keyed on the set and the categories it cannot choose between, so a hundred
    // transactions hitting one bad pair read as one defect.
    const conflictKeys = (evaluation: typeof now): Set<string> => {
      const keys = new Set<string>();
      for (const outcome of evaluation.sets) {
        if (!proposed.has(outcome.setId)) continue;
        for (const problem of outcome.problems)
          if (problem.kind === "conflict")
            keys.add(`${outcome.setId}#${[...problem.categories].sort().join(",")}`);
      }
      return keys;
    };
    const had = conflictKeys(was);

    for (const outcome of now.sets) {
      if (!proposed.has(outcome.setId)) continue;
      for (const problem of outcome.problems) {
        if (problem.kind !== "conflict") continue;
        const key = `${outcome.setId}#${[...problem.categories].sort().join(",")}`;
        // Only what the proposal brought. A set that was already claiming two
        // answers is a defect to report elsewhere, not something to blame on
        // whoever is reading this preview.
        if (had.has(key)) continue;
        const existing = conflicts.get(key);
        if (existing) existing.transactions += 1;
        else
          conflicts.set(key, {
            setId: outcome.setId,
            categories: [...problem.categories],
            transactions: 1,
            example: candidate.description,
          });
      }
    }

    if (from === undefined && to !== undefined) {
      record(gained, candidate, change);
      continue;
    }
    if (from !== undefined && to === undefined) {
      record(lost, candidate, change);
      continue;
    }
    if (from !== to) {
      record(recategorised, candidate, change);
      continue;
    }

    // The answer did not move. That is only worth reporting when the proposal
    // had something to say about this transaction at all.
    const spoke = now.sets.some((o) => proposed.has(o.setId) && o.category !== undefined);
    if (!spoke) continue;

    const won = now.effective !== undefined && proposed.has(now.effective.setId);
    record(won ? unchanged : outranked, candidate, change);
  }

  return {
    gained: settle(gained),
    lost: settle(lost),
    recategorised: settle(recategorised),
    unchanged: settle(unchanged),
    outranked: settle(outranked),
    introducedConflicts: [...conflicts.values()].sort(
      (a, b) => b.transactions - a.transactions || a.setId.localeCompare(b.setId),
    ),
    scanned: corpus.length,
  };
}
