/**
 * Categorise the household's ledger by applying its rule sets.
 *
 * One operation, two triggers: a new transaction arrives, or a rule set version
 * changes. Both are the same thing — evaluate, compare with what is stored, and
 * append a version where the answer differs.
 *
 * **Scope cannot be narrowed by a changed rule's footprint.** Composition breaks
 * that: a new `refine` changes the outcome for transactions where a *different*
 * rule did the asserting. Full re-application over the range is the honest
 * default.
 *
 * **Write volume is proportional to changes, not to transactions.** An unchanged
 * answer writes nothing, which is what makes re-applying the whole ledger cheap
 * enough to be the default.
 *
 * **Idempotency is load-bearing.** Applying the same set versions to the same
 * transactions must give the same answer, or every run appends versions and the
 * history fills with churn. There is a test for exactly that.
 *
 * See docs/design/categorisation.md.
 */

import { Categorisation } from "../categorisation/categorisation.js";
import { RuleSet } from "../categorisation/rules.js";
import { evaluate, type Evaluation } from "../categorisation/evaluate.js";
import type { Candidate } from "../categorisation/taxonomy.js";
import type { CategoryId } from "../categorisation/category.js";
import type { Categorisations, RuleSets, Row, Transactions } from "../ports/outbound/index.js";
import type { DateRange } from "../ports/index.js";

/**
 * What applying the rules concluded about one transaction.
 *
 * `Decision`, `DecideArgs` and `decide` are exported from this module so they
 * can be tested directly — the rules about custody and idempotency are worth
 * asserting one at a time — but they are deliberately NOT re-exported from the
 * package. A driver reaching past `categorise` to decide for itself is how the
 * read side ended up with three callers each reaching in at whatever depth
 * suited it.
 */
export type Decision =
  /** The rules produce what is already stored. Writes nothing. */
  | { readonly kind: "unchanged" }
  /** The answer changed, or there was none. Appends the next version. */
  | { readonly kind: "append"; readonly next: Categorisation }
  /**
   * What is stored came from an authored set, so nothing derived may replace it.
   *
   * Custody is structural rather than remembered. Derived data overwriting
   * authored data has already happened here — placeholder account details
   * overwrote real ones and every current account read "unknown" for a while —
   * and "improve the rules" must not be an operation capable of destroying the
   * only data that cannot be rebuilt.
   */
  | { readonly kind: "protected"; readonly by: string }
  /**
   * Something is stored, and nothing matches any more.
   *
   * Left alone and surfaced. Silently keeping a category nobody can explain is
   * worse than saying so, and deleting it would lose the history.
   */
  | { readonly kind: "orphaned"; readonly category: CategoryId }
  /** No rule matched and nothing was stored. The backlog, not a failure. */
  | { readonly kind: "none" };

export interface DecideArgs {
  readonly evaluation: Evaluation;
  readonly current?: Categorisation | undefined;
  /** Set ids that may never be regenerated. */
  readonly authored: ReadonlySet<string>;
  readonly dedupKey: string;
  readonly timestamp: string;
  readonly now: string;
}

/**
 * What to do about one transaction.
 *
 * "Unchanged" means the same category, not the same provenance. A rule edit that
 * bumps a set version without changing any answer would otherwise rewrite every
 * row in the ledger, which is exactly the write volume this design exists to
 * avoid. The stored `setVersion` is therefore the version that first produced
 * the answer, not the last one to agree with it — and because a set version is
 * immutable and a transaction is content-addressed, "does the current version
 * still agree" is a fold away.
 */
export function decide(args: DecideArgs): Decision {
  const { evaluation, current, authored } = args;

  if (current && authored.has(current.setId)) return { kind: "protected", by: current.setId };

  const effective = evaluation.effective;
  if (!effective) {
    return current ? { kind: "orphaned", category: current.category } : { kind: "none" };
  }
  if (current && current.category === effective.category) return { kind: "unchanged" };

  return {
    kind: "append",
    next: {
      dedupKey: args.dedupKey,
      timestamp: args.timestamp,
      category: effective.category,
      setId: effective.setId,
      setVersion: effective.version,
      version: (current?.version ?? 0) + 1,
      status: "effective",
      appliedAt: args.now,
    },
  };
}

export interface CategoriseDependencies {
  /** One range query returns the transactions and their categorisations. */
  readonly transactions: Transactions;
  readonly ruleSets: RuleSets;
  readonly categorisations: Categorisations;
}

/** One transaction the run would change, and to what. */
export interface ProposedChange {
  readonly dedupKey: string;
  readonly description: string;
  /** What is stored now, if anything. */
  readonly from?: string | undefined;
  readonly to: string;
  readonly setId: string;
}

export interface CategoriseOptions {
  readonly range: DateRange;
  /** Stamped on everything written by this run. */
  readonly now: Date;
  /** Decide and count, write nothing. */
  readonly dryRun?: boolean | undefined;
}

export interface CategoriseReport {
  readonly scanned: number;
  readonly unchanged: number;
  readonly appended: number;
  readonly protectedFromChange: number;
  readonly orphaned: number;
  readonly uncategorised: number;
  /**
   * Sets claiming two answers at once, and qualifiers with nothing to qualify.
   *
   * Counts, because they are a trigger rather than a report: which rules
   * collided is a re-application away, and every categorisation here is
   * reproducible by construction.
   */
  readonly conflicts: number;
  readonly inertRefines: number;
  /**
   * What a dry run would have written.
   *
   * Populated on a dry run only. `appended: 412` is not something anyone can
   * check; a list of what changes and to what is, and reading it before applying
   * is the whole reason for running dry.
   *
   * Empty on a real run. It holds descriptions, which are merchants and people's
   * names, so it is for a terminal and never for a file.
   */
  readonly changes: readonly ProposedChange[];
}

export async function categorise(
  deps: CategoriseDependencies,
  tenantId: string,
  options: CategoriseOptions,
): Promise<CategoriseReport> {
  const sets = (await deps.ruleSets.listRuleSets(tenantId)).map((r) => RuleSet.parse(r));
  const authored = new Set(sets.filter((s) => s.authored).map((s) => s.setId));

  const { transactions, categorisations } = await deps.transactions.listRange(tenantId, options.range);
  const current = latestByTransaction(categorisations);
  const now = options.now.toISOString();

  let unchanged = 0;
  let appended = 0;
  let protectedFromChange = 0;
  let orphaned = 0;
  let uncategorised = 0;
  let conflicts = 0;
  let inertRefines = 0;
  const changes: ProposedChange[] = [];

  for (const row of transactions) {
    const candidate = candidateOf(row);
    const evaluation = evaluate(sets, candidate);

    for (const set of evaluation.sets) {
      for (const p of set.problems) {
        if (p.kind === "conflict") conflicts += 1;
        else inertRefines += 1;
      }
    }

    const decision = decide({
      evaluation,
      current: current.get(candidate.dedupKey),
      authored,
      dedupKey: candidate.dedupKey,
      timestamp: String(row["timestamp"] ?? ""),
      now,
    });

    switch (decision.kind) {
      case "unchanged":
        unchanged += 1;
        break;
      case "append": {
        if (options.dryRun) {
          const from = current.get(candidate.dedupKey)?.category;
          changes.push({
            dedupKey: candidate.dedupKey,
            description: candidate.description,
            ...(from === undefined ? {} : { from }),
            to: decision.next.category,
            setId: decision.next.setId,
          });
        } else {
          await deps.categorisations.putCategorisation(tenantId, decision.next);
        }
        appended += 1;
        break;
      }
      case "protected":
        protectedFromChange += 1;
        break;
      case "orphaned":
        orphaned += 1;
        break;
      case "none":
        uncategorised += 1;
        break;
    }
  }

  return {
    scanned: transactions.length,
    unchanged,
    appended,
    protectedFromChange,
    orphaned,
    uncategorised,
    conflicts,
    inertRefines,
    changes,
  };
}

/** What a rule is allowed to see of a transaction. Deliberately less than a row. */
function candidateOf(row: Row): Candidate {
  const providerCategory = row["providerCategory"];
  return {
    dedupKey: String(row["dedupKey"] ?? ""),
    description: String(row["description"] ?? ""),
    amount: Number(row["amount"] ?? 0),
    currency: String(row["currency"] ?? "GBP"),
    ...(typeof providerCategory === "string" ? { providerCategory } : {}),
  };
}

/**
 * The categorisation in force for each transaction.
 *
 * Versions of one categorisation sort adjacently, but a scan is not a promise of
 * order, so the highest version wins explicitly rather than the last one seen.
 * A `proposed` version is not in force: it exists so an approval flow has a
 * shape, and until one exists it must not change what anything reads.
 */
function latestByTransaction(rows: readonly Row[]): Map<string, Categorisation> {
  const out = new Map<string, Categorisation>();
  for (const row of rows) {
    const parsed = Categorisation.safeParse(row);
    if (!parsed.success || parsed.data.status !== "effective") continue;
    const existing = out.get(parsed.data.dedupKey);
    if (!existing || parsed.data.version > existing.version) out.set(parsed.data.dedupKey, parsed.data);
  }
  return out;
}
