import type { AccountView } from "@tightarse/api-contract";

/**
 * The dashboard's arithmetic, separated from the markup that shows it.
 *
 * This was computed inline in `App.tsx` and reachable only by rendering the
 * whole component, which is why the package sat at 58% of functions against 85%
 * of lines. The numbers here are the ones a household actually reads — a wrong
 * sign is a £567.90 debt displayed as cash, which has happened.
 */

export interface NetPosition {
  /** Accounts whose balance is money the household has. */
  readonly inCredit: readonly AccountView[];
  /** Accounts whose balance is money the household owes. */
  readonly cards: readonly AccountView[];
  readonly cardIds: ReadonlySet<string>;
  /**
   * Accounts that have not said whether they are a card yet.
   *
   * Excluded from every total below rather than guessed at. See `netPosition`.
   */
  readonly unknown: readonly AccountView[];
  /** Cash across current accounts. */
  readonly netCash: number;
  /** Total owed on cards, as a positive number. */
  readonly owed: number;
  /** What the household is actually worth: cash less card debt. */
  readonly net: number;
  /**
   * True when at least one account could not be classified, so `net` is a
   * partial figure rather than the household's position. The dashboard says so
   * rather than showing an authoritative-looking number that is missing an
   * account.
   */
  readonly provisional: boolean;
}

/**
 * Split the accounts and total them up.
 *
 * `isCard` is deliberately three-valued here. A balance arriving before the
 * account details leaves a row with `currentBalance` and no `isCard` at all
 * (#29), and `undefined` is falsy — so `filter(a => a.isCard)` read a missing
 * flag as a definite "not a card" and added a debt to cash. For a card that is
 * wrong by twice the balance, because the amount should have been subtracted.
 *
 * The window is one sync, so this is transient and rare — and it is open at
 * exactly the moment someone has opened the dashboard to watch a new account
 * appear. Ingest now fetches details before balances so the state should not
 * arise, but that ordering can be changed by someone who does not know it is
 * load-bearing, and this check cannot be broken silently.
 */
export function netPosition(accounts: readonly AccountView[]): NetPosition {
  // `=== true` / `=== false` rather than truthiness: absent means NOT YET
  // KNOWN, which the contract documents and which is neither of the other two.
  const cards = accounts.filter((a) => a.isCard === true);
  const inCredit = accounts.filter((a) => a.isCard === false);
  const unknown = accounts.filter((a) => a.isCard === undefined || a.isCard === null);
  const cardIds = new Set(cards.map((c) => c.accountId));
  const netCash = inCredit.reduce((s, a) => s + (a.currentBalance ?? 0), 0);
  const owed = cards.reduce((s, a) => s + (a.currentBalance ?? 0), 0);
  return {
    inCredit,
    cards,
    cardIds,
    unknown,
    netCash,
    owed,
    net: netCash - owed,
    provisional: unknown.length > 0,
  };
}

/**
 * The balance to show on an account tile, in the household's sign convention:
 * negative left the household, positive arrived.
 *
 * The provider reports a card from the issuer's point of view, so a balance
 * owed arrives positive. Showing it unchanged puts a debt in the same column,
 * and the same colour, as savings.
 *
 * Undefined stays undefined rather than becoming zero — "we do not know this
 * balance" and "this balance is nothing" are different, and the tile renders
 * them differently.
 */
export function tileBalance(account: AccountView, isCard: boolean): number | undefined {
  if (account.currentBalance === undefined) return undefined;
  return isCard ? -account.currentBalance : account.currentBalance;
}

/**
 * The date range for a lookback in days, ending today.
 *
 * `now` is a parameter because a function deriving both ends from `Date.now()`
 * is a function that passes until it doesn't.
 */
export function rangeFor(days: number, now: Date): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - days * 864e5).toISOString().slice(0, 10);
  return { from, to };
}
