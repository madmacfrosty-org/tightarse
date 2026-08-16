import { describe, it, expect } from "vitest";
import { netPosition, tileBalance, rangeFor } from "./positions";
import type { AccountView } from "@tightarse/api-contract";

/**
 * The number the dashboard leads with. It was computed inside the component and
 * only checkable by rendering, which is why `web` sat at 58% of functions.
 */

/**
 * A current account by default.
 *
 * `isCard: false` is set explicitly rather than left out. Every account row the
 * ledger writes carries the flag, so omitting it here would model a state that
 * only exists mid-sync (#29) while pretending to be the ordinary case — and
 * under the old truthiness rule the two were indistinguishable. Tests that want
 * the half-written row ask for it with `isCard: undefined`.
 */
const account = (over: Partial<AccountView> = {}): AccountView => ({
  accountId: "acc-1",
  displayName: "Current",
  institutionName: "First Direct",
  currentBalance: 100_00,
  isCard: false,
  ...over,
});

describe("net position", () => {
  it("subtracts card debt from cash rather than adding it", () => {
    // The provider reports a card from the issuer's point of view, so a balance
    // owed arrives positive. Adding it turned a £567.90 debt into £567.90 of
    // savings — the household's worth was overstated by twice the debt.
    const accounts = [
      account({ accountId: "cur", currentBalance: 1_000_00 }),
      account({ accountId: "card", currentBalance: 567_90, isCard: true }),
    ];
    expect(netPosition(accounts).net).toBe(432_10);
  });

  it("can report a negative position, when the cards exceed the cash", () => {
    // Clamping this at zero would be a comforting lie.
    const accounts = [
      account({ accountId: "cur", currentBalance: 100_00 }),
      account({ accountId: "card", currentBalance: 500_00, isCard: true }),
    ];
    expect(netPosition(accounts).net).toBe(-400_00);
  });

  it("treats an account as a card only because the ledger says so", () => {
    // Never inferred from the balances. "Available exceeds current" is true of
    // a credit card with headroom and false of Amex, which reports no available
    // balance at all.
    const amex = account({ accountId: "amex", currentBalance: 200_00, isCard: true });
    const flush = account({ accountId: "savings", currentBalance: 50_00, availableBalance: 90_00 });
    const { cards, inCredit } = netPosition([amex, flush]);
    expect(cards.map((c) => c.accountId)).toEqual(["amex"]);
    expect(inCredit.map((c) => c.accountId)).toEqual(["savings"]);
  });

  it("will not guess at an account that has not said whether it is a card", () => {
    // The £567.90 bug arrived at from a different direction. Not a wrong sign
    // this time — a missing flag read as a definite "no". `undefined` is falsy,
    // so `filter(a => a.isCard)` put a debt in the cash column and the position
    // was overstated by twice the balance.
    const half = account({ accountId: "half-written", currentBalance: 567_90, isCard: undefined });
    const cash = account({ accountId: "cur", currentBalance: 1_000_00 });
    const p = netPosition([cash, half]);

    expect(p.unknown.map((a) => a.accountId)).toEqual(["half-written"]);
    expect(p.cards).toEqual([]);
    expect(p.inCredit.map((a) => a.accountId)).toEqual(["cur"]);
    // Excluded entirely rather than counted either way.
    expect(p.net).toBe(1_000_00);
    expect(p.provisional).toBe(true);
  });

  it("is not provisional when every account is classified", () => {
    // Otherwise the warning becomes permanent furniture and stops being read.
    const p = netPosition([
      account({ accountId: "cur", currentBalance: 100_00 }),
      account({ accountId: "card", currentBalance: 50_00, isCard: true }),
    ]);
    expect(p.provisional).toBe(false);
    expect(p.unknown).toEqual([]);
    expect(p.net).toBe(50_00);
  });

  it("distinguishes a known-false flag from an absent one", () => {
    // The distinction the whole fix rests on: `false` is an answer, `undefined`
    // is the absence of one, and a truthiness check cannot tell them apart.
    const known = netPosition([account({ accountId: "a", currentBalance: 10_00, isCard: false })]);
    const absent = netPosition([account({ accountId: "a", currentBalance: 10_00, isCard: undefined })]);

    expect(known.netCash).toBe(10_00);
    expect(known.provisional).toBe(false);
    expect(absent.netCash).toBe(0);
    expect(absent.provisional).toBe(true);
  });

  it("counts an account with no balance as nothing, not as a gap in the total", () => {
    // A missing balance must not make the whole figure NaN, which renders as
    // "£NaN" and is indistinguishable from a broken sync.
    const accounts = [account({ accountId: "a", currentBalance: 100_00 }), account({ accountId: "b", currentBalance: undefined })];
    expect(netPosition(accounts).net).toBe(100_00);
  });

  it("is zero for a household with no accounts, not NaN", () => {
    expect(netPosition([]).net).toBe(0);
  });
});

describe("the balance shown on a tile", () => {
  it("shows card debt as negative, so it reads as money owed", () => {
    expect(tileBalance(account({ currentBalance: 567_90, isCard: true }), true)).toBe(-567_90);
  });

  it("leaves a current account's balance alone", () => {
    expect(tileBalance(account({ currentBalance: 1_000_00 }), false)).toBe(1_000_00);
  });

  it("keeps an unknown balance unknown rather than showing it as zero", () => {
    // "We do not know" and "there is nothing there" are different, and the tile
    // renders them differently — a dash, not £0.00.
    expect(tileBalance(account({ currentBalance: undefined }), false)).toBeUndefined();
  });
});

describe("the range a lookback asks for", () => {
  it("ends today and starts the requested number of days earlier", () => {
    expect(rangeFor(90, new Date("2026-08-14T09:00:00Z"))).toEqual({
      from: "2026-05-16",
      to: "2026-08-14",
    });
  });

  it("crosses a year boundary without landing in the wrong year", () => {
    expect(rangeFor(365, new Date("2026-01-10T00:00:00Z")).from).toBe("2025-01-10");
  });

  it("handles the five-year range across leap days", () => {
    // 365*5 days is not five calendar years — there are leap days in between,
    // so this deliberately asserts the day arithmetic rather than the year.
    expect(rangeFor(365 * 5, new Date("2026-08-14T00:00:00Z")).from).toBe("2021-08-15");
  });
});
