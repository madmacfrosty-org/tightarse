/**
 * Saying by hand that two accounts are one, and taking it back.
 *
 * The automatic match (`ledger/account-renames.ts`) needs two transactions in
 * common, which is strong evidence and cannot cover everything. An account
 * renamed while dormant has no transactions either side of the change and will
 * never be matched; and a match, however good the evidence, can be wrong.
 *
 * So both directions are here. Neither rewrites anything — a link is one field
 * on the superseded account, and the transactions stay where they are and are
 * read under whichever account is current.
 */

import { currentAccounts, resolvedAccountIds, type LinkedAccount } from "../ledger/account-renames.js";
import type { Accounts, Row } from "../ports/outbound/index.js";

export interface AccountLinkDeps {
  readonly ledger: Pick<Accounts, "listAccounts" | "markSuperseded" | "clearSuperseded">;
}

export class AccountNotFound extends Error {
  readonly statusCode = 404;
  constructor(accountId: string) {
    super(`No account ${accountId} in this household.`);
    this.name = "AccountNotFound";
  }
}

export class CannotJoinToItself extends Error {
  readonly statusCode = 400;
  constructor() {
    super("An account cannot continue itself.");
    this.name = "CannotJoinToItself";
  }
}

export class AlreadyJoined extends Error {
  readonly statusCode = 409;
  constructor(accountId: string, to: string) {
    super(`${accountId} already continues into ${to}. Separate them first.`);
    this.name = "AlreadyJoined";
  }
}

export class WouldMakeALoop extends Error {
  readonly statusCode = 409;
  constructor() {
    // Reading an id follows the chain to its end. A loop has no end, and the
    // resolver stops rather than hanging — so the figures would be decided by
    // where the walk happened to start, which is no answer at all.
    super("That would make two accounts continue into each other.");
    this.name = "WouldMakeALoop";
  }
}

const idOf = (row: Row): string => String(row["accountId"] ?? "");

function toLinked(row: Row): LinkedAccount {
  return {
    accountId: idOf(row),
    ...(typeof row["supersededBy"] === "string" && row["supersededBy"] !== ""
      ? { supersededBy: row["supersededBy"] }
      : {}),
  };
}

/**
 * Record that one account continues into another.
 *
 * `by` is the person, stored instead of a count so the screen can say a person
 * decided this rather than implying a machine found evidence it did not.
 */
export async function joinAccounts(
  deps: AccountLinkDeps,
  tenantId: string,
  supersededId: string,
  survivingId: string,
  by: string,
  now: Date = new Date(),
): Promise<{ supersededId: string; survivingId: string }> {
  if (supersededId === survivingId) throw new CannotJoinToItself();

  const rows = await deps.ledger.listAccounts(tenantId);
  const known = new Map(rows.map((r) => [idOf(r), r]));
  for (const id of [supersededId, survivingId]) {
    if (!known.has(id)) throw new AccountNotFound(id);
  }

  const existing = known.get(supersededId)!["supersededBy"];
  if (typeof existing === "string" && existing !== "") {
    throw new AlreadyJoined(supersededId, existing);
  }

  // Follow the surviving account forwards. If the chain reaches the account
  // being superseded, joining them closes a loop.
  const ids = resolvedAccountIds(rows.map(toLinked));
  if (ids.get(survivingId) === supersededId) throw new WouldMakeALoop();

  await deps.ledger.markSuperseded(tenantId, supersededId, survivingId, now.toISOString(), {
    by,
  });
  return { supersededId, survivingId };
}

/**
 * Take a link back.
 *
 * Deliberately not refused when there is no link: being asked for a state that
 * already holds is not a failure, and a button that errors for having nothing
 * to do teaches people to distrust it.
 */
export async function separateAccounts(
  deps: AccountLinkDeps,
  tenantId: string,
  accountId: string,
): Promise<{ accountId: string }> {
  const rows = await deps.ledger.listAccounts(tenantId);
  if (!rows.some((r) => idOf(r) === accountId)) throw new AccountNotFound(accountId);

  await deps.ledger.clearSuperseded(tenantId, accountId);
  return { accountId };
}

/** One account this one has absorbed, and on whose say-so. */
export interface ContinuedAccount {
  readonly accountId: string;
  readonly displayName?: string | undefined;
  readonly since?: string | undefined;
  /** Transactions the two held in common. Absent when a person joined them. */
  readonly sharedTransactions?: number | undefined;
  /** Who joined them. Absent when it was worked out automatically. */
  readonly joinedBy?: string | undefined;
}

/**
 * What each surviving account continues, keyed by the account still in use.
 *
 * The link is stored on the superseded account, which is the right place to
 * write it — that row is finished and will not be touched again. It is the
 * wrong place to read it: the screen lists the accounts a household has, and
 * each of those needs to say what it absorbed.
 */
export function continuedBy(rows: readonly Row[]): Map<string, ContinuedAccount[]> {
  const held = new Set(currentAccounts(rows.map(toLinked)).map((a) => a.accountId));
  const ids = resolvedAccountIds(rows.map(toLinked));

  const by = new Map<string, ContinuedAccount[]>();
  for (const row of rows) {
    const supersededBy = row["supersededBy"];
    if (typeof supersededBy !== "string" || supersededBy === "") continue;

    // Attributed to the end of the chain, not the next link. An account
    // replaced twice belongs to the card in the wallet now, which is the only
    // one on screen to attach it to.
    // Always present: the map is built from these same rows.
    const current = ids.get(idOf(row))!;
    if (!held.has(current)) continue;

    const entry: ContinuedAccount = {
      accountId: idOf(row),
      ...(typeof row["displayName"] === "string" ? { displayName: row["displayName"] } : {}),
      ...(typeof row["reconciledAt"] === "string" ? { since: row["reconciledAt"] } : {}),
      ...(typeof row["reconciledShared"] === "number"
        ? { sharedTransactions: row["reconciledShared"] }
        : {}),
      ...(typeof row["reconciledBy"] === "string" ? { joinedBy: row["reconciledBy"] } : {}),
    };
    by.set(current, [...(by.get(current) ?? []), entry]);
  }
  return by;
}
