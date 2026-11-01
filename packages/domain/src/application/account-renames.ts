/**
 * Record the accounts the provider has renamed.
 *
 * The use case, not the job: it reads through ports, decides, and writes what
 * it decided. A phase of its own for the same reason balance reconciliation is
 * — the evidence is the whole ledger, and the transform runs once per raw
 * object with no ordering between them.
 *
 * Safe to re-run. `markSuperseded` is conditional on the field being absent,
 * so a second pass re-offers the same conclusion and changes nothing.
 *
 * See `ledger/account-renames.ts` for why a provider account id cannot be
 * trusted as an identity, and #199 for what it cost this household.
 */

import {
  detectRenames,
  type ComparableTransaction,
  type LinkedAccount,
  type RenamedAccount,
} from "../ledger/account-renames.js";
import { emit } from "@tightarse/metrics";
import type { Accounts, LedgerReads, Row } from "../ports/outbound/index.js";

/**
 * How far behind the household's newest sync an account may fall and still
 * count as one the provider returns.
 *
 * The sync runs daily, so a live account is always within a day. One the
 * provider has stopped returning falls behind immediately and never catches
 * up.
 *
 * Generous rather than tight, because the cost is asymmetric. Judging a live
 * account absent is what would allow a wrong merge; judging a dropped account
 * present only delays recognising a rename by a day. Two days of slack buys
 * the first safety at the price of the second.
 */
const STILL_RETURNED_MS = 48 * 60 * 60 * 1000;

/**
 * Which account ids the provider is still returning, read from our own rows.
 *
 * `detectRenames` needs this and the sync does not hand it over — the sync is
 * per-connection and this decision is household-wide. Deriving it from
 * `lastSyncedAt` needs no new plumbing and, more importantly, fails in the
 * right direction.
 *
 * A broken or suspended connection makes all of its accounts look absent. That
 * cannot cause a wrong merge, because a rename requires exactly one of the pair
 * to be present: if both look absent, nothing is concluded. So the failure mode
 * of this inference is a rename recognised late, never two real accounts joined.
 */
export function stillReturned(rows: readonly Row[]): Set<string> {
  const syncedAt = (r: Row): number => {
    const at = r["lastSyncedAt"];
    return typeof at === "string" ? Date.parse(at) : Number.NaN;
  };
  const times = rows.map(syncedAt).filter((t) => Number.isFinite(t));
  // Nothing has ever synced, so nothing is known to be returned. An empty set
  // means `detectRenames` concludes nothing, which is correct: there is no
  // evidence here either way.
  if (times.length === 0) return new Set();
  // The household's own newest sync rather than the clock, so a run days after
  // the last successful sync judges accounts against each other rather than
  // against today and declaring every one of them gone.
  const newest = Math.max(...times);

  const present = new Set<string>();
  for (const r of rows) {
    const at = syncedAt(r);
    if (!Number.isFinite(at)) continue;
    if (newest - at <= STILL_RETURNED_MS) {
      present.add(String(r["accountId"] ?? ""));
    }
  }
  present.delete("");
  return present;
}

/** The row, narrowed to what a rename decision reads. */
function toLinked(row: Row): LinkedAccount {
  return {
    accountId: String(row["accountId"] ?? ""),
    ...(typeof row["supersededBy"] === "string" && row["supersededBy"] !== ""
      ? { supersededBy: row["supersededBy"] }
      : {}),
  };
}

/** The transaction, narrowed to what the evidence reads. */
function toComparable(row: Row): ComparableTransaction {
  return {
    accountId: String(row["accountId"] ?? ""),
    timestamp: String(row["timestamp"] ?? ""),
    amount: typeof row["amount"] === "number" ? row["amount"] : 0,
    description: typeof row["description"] === "string" ? row["description"] : "",
    ...(typeof row["providerTransactionId"] === "string"
      ? { providerTransactionId: row["providerTransactionId"] }
      : {}),
    ...(typeof row["normalisedProviderTransactionId"] === "string"
      ? { normalisedProviderTransactionId: row["normalisedProviderTransactionId"] }
      : {}),
  };
}

export interface RenameDeps {
  readonly ledger: Pick<LedgerReads, "listAccounts" | "listRange"> &
    Pick<Accounts, "markSuperseded">;
}

/**
 * Find and record renames for one household.
 *
 * Returns what it recorded so a job can log and measure it. Writing is the
 * point, though: until the link is on the row, every read still counts the
 * retired account.
 */
export async function recordAccountRenames(
  deps: RenameDeps,
  tenantId: string,
  now: Date = new Date(),
): Promise<RenamedAccount[]> {
  const [rows, history] = await Promise.all([
    deps.ledger.listAccounts(tenantId),
    deps.ledger.listRange(tenantId, {
      from: "1970-01-01",
      to: now.toISOString().slice(0, 10),
    }),
  ]);

  const found = detectRenames({
    accounts: rows.map(toLinked),
    movements: history.transactions.map(toComparable),
    present: stillReturned(rows),
  });

  // Sequentially, not in parallel. There are at most a couple of these in a
  // household's lifetime, and a conditional write that races itself is a
  // puzzle nobody should have to solve for no gain.
  for (const r of found) {
    await deps.ledger.markSuperseded(
      tenantId,
      r.supersededId,
      r.survivingId,
      now.toISOString(),
    );
  }
  return found;
}

/**
 * The job around the use case: run it, say what it did, measure it.
 *
 * Split the same way balance reconciliation is — `recordAccountRenames`
 * decides and writes, this names and counts. A rename is rare and
 * consequential, so it gets a line of its own in the log rather than only a
 * metric: a household whose chart suddenly lengthens should be able to find
 * out why.
 *
 * `RenamesRecorded` is the number to alarm on, and it should be zero almost
 * always. Anything above zero is either a card replaced or this concluding
 * something it should not have, and both are worth a person looking. That
 * alarm needs a subscriber, which is #67.
 */
export async function recordRenamesFrom(
  deps: RenameDeps,
  config: { readonly tenantId: string; readonly environment: string },
  now: Date = new Date(),
  write?: (line: string) => void,
): Promise<RenamedAccount[]> {
  const found = await recordAccountRenames(deps, config.tenantId, now);
  const say = write ?? console.log;

  for (const r of found) {
    // Ids, not names. An account's display name is the household's own and
    // belongs in the dashboard rather than in CloudWatch.
    say(
      `account ${r.supersededId} is the same account as ${r.survivingId} ` +
        `(${r.evidence.shared} transactions in common); its history now reads ` +
        `under the latter`,
    );
  }

  emit(
    {
      namespace: "Tightarse",
      // The deployment, not the TrueLayer environment. A metric emitted under
      // "live" is invisible to an alarm watching "dev", which is #31.
      environment: config.environment,
      metrics: { RenamesRecorded: found.length },
      properties: { tenantId: config.tenantId },
    },
    ...(write ? [write] : []),
  );

  return found;
}
