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
  /** Cash across current accounts. */
  readonly netCash: number;
  /** Total owed on cards, as a positive number. */
  readonly owed: number;
  /** What the household is actually worth: cash less card debt. */
  readonly net: number;
}

export function netPosition(accounts: readonly AccountView[]): NetPosition {
  const cards = accounts.filter((a) => a.isCard);
  const cardIds = new Set(cards.map((c) => c.accountId));
  const inCredit = accounts.filter((a) => !cardIds.has(a.accountId));
  const netCash = inCredit.reduce((s, a) => s + (a.currentBalance ?? 0), 0);
  const owed = cards.reduce((s, a) => s + (a.currentBalance ?? 0), 0);
  return { inCredit, cards, cardIds, netCash, owed, net: netCash - owed };
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
