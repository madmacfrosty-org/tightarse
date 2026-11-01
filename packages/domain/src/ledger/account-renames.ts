/**
 * Accounts the provider has renamed.
 *
 * TrueLayer's `account_id` is not an identity. They generate it from fields the
 * provider returns, and those fields change — on a reissued card, on a
 * reauthentication, on an account upgrade. When it changes, the same account
 * arrives under a new name and we ingest it as a second account: the history
 * stops and restarts beside itself, the total counts both, and the chart
 * clamps to the newer one's first day because `completeFrom` correctly refuses
 * to draw a total over a period it believes is missing an account. #199.
 *
 * Two of this household's cards were replaced in October 2026 and all of that
 * happened, including a four-figure sum of card debt that no longer existed
 * being counted against them.
 *
 * ## A recorded rename, not an identity of our own
 *
 * The tempting fix is to give an account an identity of our own, derived from
 * something stable. It is the wrong one. It changes every account's id, so
 * every `dedupKey`, so every categorisation's join — a migration across the
 * whole ledger to fix two accounts. It needs account numbers kept in the
 * database. And it is not even sound, because an account upgrade changes the
 * number it would be derived from.
 *
 * So the stored id stays the provider's, and nothing is renamed. Instead, when
 * the set of ids a connection returns changes, we ask whether a new one is an
 * old one, and record the answer. The provider renaming something it has
 * already told us about is one event with several causes, and this handles all
 * of them.
 *
 * ## What counts as evidence
 *
 * Only facts the account holder cannot change. `name_on_card` changes on
 * marriage; `display_name` was observed changing on one of these very cards;
 * `partial_card_number` is four digits that share nothing between an old card
 * and its replacement. All rejected.
 *
 * What survives is the provider's own transaction ids. The same transaction
 * comes back under both account ids with the same id, which is the provider
 * telling us directly that these are the same transactions — and an account is
 * the transactions it holds.
 */

import { transactionIdentity } from "./transaction.js";

/** Just enough of an account row to reconcile and resolve. */
export interface LinkedAccount {
  readonly accountId: string;
  /**
   * The account that superseded this one, once established.
   *
   * Recorded on the superseded account rather than the surviving one. The
   * surviving row is rewritten by every sync; this one is finished and will
   * not be touched again, so the link sits on the stable half.
   */
  readonly supersededBy?: string | undefined;
}

/** A transaction, as reconciliation needs to see it. */
export interface ComparableTransaction {
  readonly accountId: string;
  readonly timestamp: string;
  readonly amount: number;
  readonly description: string;
  readonly providerTransactionId?: string | undefined;
  readonly normalisedProviderTransactionId?: string | undefined;
}

/**
 * How many shared transactions are enough to conclude two ids are one account.
 *
 * One is not. A single match can arise from a provider reusing a transaction
 * id, which `dedupKey`'s own notes record happening on card rows, and merging
 * two real accounts is far worse than leaving a rename unreconciled for
 * another day. Two independent matches of a provider identifier combined with
 * time, amount and description do not happen by chance.
 *
 * Observed on the real pair: 86 and 6.
 */
const ENOUGH = 2;

/** Why we believe two account ids name one account. */
export interface RenameEvidence {
  readonly kind: "transaction-overlap";
  /** How many transactions the two ids hold in common. */
  readonly shared: number;
}

/** A rename we are prepared to act on. */
export interface RenamedAccount {
  /** The id the provider has stopped returning. */
  readonly supersededId: string;
  /** The id it now returns instead. */
  readonly survivingId: string;
  readonly evidence: RenameEvidence;
}

/**
 * Which account ids hold a transaction in common.
 *
 * The standing check, not a migration step. An identity under more than one
 * account id is an unreconciled rename or a bug, and either way it means a
 * household's money is being counted twice.
 *
 * Deliberately blind to genuine double charges. Two real charges carry
 * different provider transaction ids, so they are two identities and stay two
 * transactions. A ledger that hid duplicate charges would be worse than one
 * that showed them.
 */
export function sharedIdentities(
  movements: readonly ComparableTransaction[],
): Map<string, Set<string>> {
  const holders = new Map<string, Set<string>>();
  for (const m of movements) {
    const id = transactionIdentity(m);
    const seen = holders.get(id);
    if (seen === undefined) holders.set(id, new Set([m.accountId]));
    else seen.add(m.accountId);
  }
  for (const [id, accounts] of holders) {
    if (accounts.size < 2) holders.delete(id);
  }
  return holders;
}

/**
 * How many transactions each pair of account ids holds in common.
 *
 * Keyed by both ids in a stable order, so a pair is counted once however its
 * transactions happen to be ordered.
 */
export function overlaps(
  movements: readonly ComparableTransaction[],
): Map<string, { readonly a: string; readonly b: string; readonly shared: number }> {
  const counts = new Map<
    string,
    { readonly a: string; readonly b: string; shared: number }
  >();
  for (const accounts of sharedIdentities(movements).values()) {
    const ids = [...accounts].sort();
    // Every pair within the set, not just the first two: three ids sharing a
    // transaction is a chain of two renames, and each link needs its own count.
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i]!;
        const b = ids[j]!;
        const key = `${a}|${b}`;
        const at = counts.get(key);
        if (at === undefined) counts.set(key, { a, b, shared: 1 });
        else at.shared += 1;
      }
    }
  }
  return counts;
}

/**
 * The renames worth recording.
 *
 * `present` is the set of ids the provider returned on this sync. It is the
 * load-bearing argument and the whole safety guard: two ids returned together
 * are two accounts the household holds at once, whatever their transactions
 * look like, and must never be merged. A rename is the other shape — one id
 * stops being returned and another appears.
 *
 * Without that guard, shared transactions alone would merge a pair of real
 * accounts that happen to show both sides of an internal transfer. With it,
 * such a pair is excluded before the evidence is even weighed.
 *
 * Returns nothing for an account already reconciled, so this is safe to run on
 * every sync.
 */
export function detectRenames(args: {
  readonly accounts: readonly LinkedAccount[];
  readonly movements: readonly ComparableTransaction[];
  readonly present: ReadonlySet<string>;
}): RenamedAccount[] {
  const { accounts, movements, present } = args;
  const known = new Set(accounts.map((a) => a.accountId));
  const linked = new Set(
    accounts.filter((a) => a.supersededBy !== undefined).map((a) => a.accountId),
  );

  const found: RenamedAccount[] = [];
  for (const { a, b, shared } of overlaps(movements).values()) {
    if (shared < ENOUGH) continue;
    // Both still returned: two accounts, not one renamed.
    if (present.has(a) && present.has(b)) continue;
    // Neither returned: both are finished, and joining two accounts that are
    // equally gone changes no figure the household is shown. Left alone rather
    // than guessed at.
    if (!present.has(a) && !present.has(b)) continue;

    const survivingId = present.has(a) ? a : b;
    const supersededId = survivingId === a ? b : a;
    if (!known.has(supersededId) || !known.has(survivingId)) continue;
    if (linked.has(supersededId)) continue;

    found.push({
      supersededId,
      survivingId,
      evidence: { kind: "transaction-overlap", shared },
    });
  }
  // Stable, so a sync that finds two renames records them in the same order
  // twice running and a test can say what it expects.
  return found.sort((x, y) => x.supersededId.localeCompare(y.supersededId));
}

/**
 * Every account id mapped to the one still in use for it.
 *
 * Built once per read rather than followed per transaction: a household with
 * twelve thousand rows should not re-walk the same two-link chain twelve
 * thousand times.
 *
 * A chain is followed to its end, so an account renamed twice reads as one
 * rather than three. A cycle — which only a bad write could produce — stops
 * rather than hanging. A wrong figure is bad; a dashboard that never loads is
 * worse, and the loop is visible in the data either way.
 */
export function resolvedAccountIds(
  accounts: readonly LinkedAccount[],
): Map<string, string> {
  const supersededBy = new Map<string, string>();
  for (const a of accounts) {
    if (a.supersededBy !== undefined && a.supersededBy !== a.accountId) {
      supersededBy.set(a.accountId, a.supersededBy);
    }
  }

  const resolved = new Map<string, string>();
  for (const a of accounts) {
    const seen = new Set<string>([a.accountId]);
    let at = a.accountId;
    for (;;) {
      const next = supersededBy.get(at);
      if (next === undefined || seen.has(next)) break;
      seen.add(next);
      at = next;
    }
    resolved.set(a.accountId, at);
  }
  return resolved;
}

/**
 * Read an account id as the account it now belongs to.
 *
 * Unknown ids pass through. A transaction can outlive the account row naming
 * it — the row is replaced on every sync and a transaction is not — and
 * dropping one would take money out of a total to tidy up an identifier.
 */
export function resolveAccountId(
  ids: ReadonlyMap<string, string>,
  accountId: string,
): string {
  return ids.get(accountId) ?? accountId;
}

/**
 * The accounts the household actually has.
 *
 * A superseded account is not a second account they hold, so it is not listed
 * and not added to anything. Its row stays in the ledger and its transactions
 * still count — under the account that replaced it.
 */
export function currentAccounts<T extends LinkedAccount>(
  accounts: readonly T[],
): T[] {
  const ids = resolvedAccountIds(accounts);
  return accounts.filter((a) => resolveAccountId(ids, a.accountId) === a.accountId);
}
