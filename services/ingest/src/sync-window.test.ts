import { describe, it, expect } from "vitest";
import type { BankLimits } from "@tightarse/ports";
import { syncWindow } from "./sync-window.js";

/**
 * TrueLayer's, measured against it. Stated here rather than imported, because the
 * point of the argument is that this function has no opinion about which provider
 * it is planning for.
 */
const limits: BankLimits = { maxHistoryMonths: 60, unattendedHistoryDays: 88, exemptionMinutes: 45 };

/**
 * How much history one sync asks for.
 *
 * Moved here with the code it tests. The limits it works within belong to the
 * provider; the decisions — how much overlap, what floor, what to do when nothing
 * has ever synced — belong to ingest.
 */

describe("syncWindow", () => {
  const connectedAt = "2026-08-13T09:00:00.000Z";
  const at = (minutes: number) => new Date(Date.parse(connectedAt) + minutes * 60_000);
  const days = (w: { from: string; to: string }) =>
    (Date.parse(w.to) - Date.parse(w.from)) / 86_400_000;

  it("asks for everything the bank will give inside the exemption window", () => {
    // The only moment deep history is available, and it does not come back.
    const w = syncWindow({ connectedAt }, limits, at(10));
    expect(w.deepHistory).toBe(true);
    expect(days(w) / 365.25).toBeGreaterThan(4.9);
  });

  it("stops short of the documented hour", () => {
    // Asking a minute late costs the whole run rather than degrading.
    expect(syncWindow({ connectedAt }, limits, at(44)).deepHistory).toBe(true);
    expect(syncWindow({ connectedAt }, limits, at(46)).deepHistory).toBe(false);
  });

  it("never asks for more than 88 days once the window has closed", () => {
    // 90 is the provider's limit and it refuses the whole call rather than
    // truncating. The first attempt at this asked for three calendar months —
    // 13 May to 13 August, 92 days — and was denied for being two days greedy.
    const w = syncWindow({ connectedAt }, limits, at(60 * 24 * 400));
    expect(days(w)).toBeLessThanOrEqual(88);
  });

  it("asks for the widest allowed window when nothing has ever synced", () => {
    // A connection that has never worked has the most to catch up on.
    const w = syncWindow({ connectedAt }, limits, at(60 * 24 * 5));
    expect(days(w)).toBe(88);
  });

  it("asks for ten days on a healthy daily sync", () => {
    // A day would do, but pending rows settle over several days and card
    // transactions arrive dated earlier than they appear. The floor buys about
    // a week of overlap for nothing.
    const now = at(60 * 24 * 30);
    const w = syncWindow(
      { connectedAt, lastSyncedAt: new Date(now.getTime() - 86_400_000).toISOString() },
      limits,
      now,
    );
    expect(days(w)).toBe(10);
  });

  it("widens to cover a gap, plus overlap", () => {
    const now = at(60 * 24 * 60);
    const w = syncWindow(
      { connectedAt, lastSyncedAt: new Date(now.getTime() - 20 * 86_400_000).toISOString() },
      limits,
      now,
    );
    expect(days(w)).toBe(23);
  });

  it("clamps a very long gap to what the provider will answer", () => {
    const now = at(60 * 24 * 400);
    const w = syncWindow(
      { connectedAt, lastSyncedAt: new Date(now.getTime() - 300 * 86_400_000).toISOString() },
      limits,
      now,
    );
    expect(days(w)).toBe(88);
  });
});
