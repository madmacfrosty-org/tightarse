import { describe, it, expect, vi, afterEach } from "vitest";
import { TrueLayerClient, TrueLayerError, historyFrom, MAX_HISTORY_MONTHS, SANDBOX , syncWindow } from "./index.js";

const creds = { clientId: "id", clientSecret: "secret" };

const mockFetch = (status: number, body: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })));

afterEach(() => vi.unstubAllGlobals());

describe("token handling", () => {
  it("returns an absolute expiry, so a stored token can be judged later", async () => {
    mockFetch(200, { access_token: "a", refresh_token: "r", expires_in: 3600 });
    const t = await new TrueLayerClient(creds, SANDBOX).refresh("old");
    expect(t.accessToken).toBe("a");
    expect(Date.parse(t.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("surfaces a rotated refresh token", async () => {
    // TrueLayer may return a NEW refresh token and invalidate the old one.
    // Keeping the original is how a connection silently dies days later.
    mockFetch(200, { access_token: "a", refresh_token: "rotated", expires_in: 3600 });
    const t = await new TrueLayerClient(creds, SANDBOX).refresh("original");
    expect(t.refreshToken).toBe("rotated");
  });

  it("fails loudly when no refresh token comes back", async () => {
    mockFetch(200, { access_token: "a", expires_in: 3600 });
    await expect(new TrueLayerClient(creds, SANDBOX).refresh("r")).rejects.toThrow(/offline_access/);
  });
});

describe("error classification", () => {
  it("identifies a lapsed consent, which a human must fix", async () => {
    mockFetch(400, { error: "invalid_grant" });
    try {
      await new TrueLayerClient(creds, SANDBOX).refresh("stale");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TrueLayerError);
      expect((e as TrueLayerError).isConsentExpired).toBe(true);
    }
  });

  it("treats 501 and 403 as not-applicable rather than failure", () => {
    // First Direct returns 501 for standing orders on every account and 403 for
    // direct debits on accounts that have none. Retrying either is pointless.
    expect(new TrueLayerError("x", 501, "endpoint_not_supported").isNotApplicable).toBe(true);
    expect(new TrueLayerError("x", 403, "access_denied").isNotApplicable).toBe(true);
    expect(new TrueLayerError("x", 500, null).isNotApplicable).toBe(false);
  });
});

describe("history window", () => {
  it("caps at the measured provider limit", () => {
    // 72 months and beyond return invalid_date_range instantly; 60 works.
    expect(MAX_HISTORY_MONTHS).toBe(60);
  });

  it("clamps month-end instead of overflowing into the next month", () => {
    // setMonth alone turns "one month before 31 March" into 3 March, because
    // 31 February rolls forward — a silent three-day gap in the fetch window.
    expect(historyFrom(1, new Date("2026-03-31T00:00:00Z"))).toBe("2026-02-28");
    expect(historyFrom(1, new Date("2024-03-31T00:00:00Z"))).toBe("2024-02-29");
    expect(historyFrom(60, new Date("2026-08-10T00:00:00Z"))).toBe("2021-08-10");
    expect(historyFrom(60, new Date("2026-03-31T00:00:00Z"))).toBe("2021-03-31");
  });
});

describe("syncWindow", () => {
  const connectedAt = "2026-08-13T09:00:00.000Z";
  const at = (minutes: number) => new Date(Date.parse(connectedAt) + minutes * 60_000);
  const days = (w: { from: string; to: string }) =>
    (Date.parse(w.to) - Date.parse(w.from)) / 86_400_000;

  it("asks for everything the bank will give inside the exemption window", () => {
    // The only moment deep history is available, and it does not come back.
    const w = syncWindow({ connectedAt }, at(10));
    expect(w.deepHistory).toBe(true);
    expect(days(w) / 365.25).toBeGreaterThan(4.9);
  });

  it("stops short of the documented hour", () => {
    // Asking a minute late costs the whole run rather than degrading.
    expect(syncWindow({ connectedAt }, at(44)).deepHistory).toBe(true);
    expect(syncWindow({ connectedAt }, at(46)).deepHistory).toBe(false);
  });

  it("never asks for more than 88 days once the window has closed", () => {
    // 90 is the provider's limit and it refuses the whole call rather than
    // truncating. The first attempt at this asked for three calendar months —
    // 13 May to 13 August, 92 days — and was denied for being two days greedy.
    const w = syncWindow({ connectedAt }, at(60 * 24 * 400));
    expect(days(w)).toBeLessThanOrEqual(88);
  });

  it("asks for the widest allowed window when nothing has ever synced", () => {
    // A connection that has never worked has the most to catch up on.
    const w = syncWindow({ connectedAt }, at(60 * 24 * 5));
    expect(days(w)).toBe(88);
  });

  it("asks for ten days on a healthy daily sync", () => {
    // A day would do, but pending rows settle over several days and card
    // transactions arrive dated earlier than they appear. The floor buys about
    // a week of overlap for nothing.
    const now = at(60 * 24 * 30);
    const w = syncWindow(
      { connectedAt, lastSyncedAt: new Date(now.getTime() - 86_400_000).toISOString() },
      now,
    );
    expect(days(w)).toBe(10);
  });

  it("widens to cover a gap, plus overlap", () => {
    const now = at(60 * 24 * 60);
    const w = syncWindow(
      { connectedAt, lastSyncedAt: new Date(now.getTime() - 20 * 86_400_000).toISOString() },
      now,
    );
    expect(days(w)).toBe(23);
  });

  it("clamps a very long gap to what the provider will answer", () => {
    const now = at(60 * 24 * 400);
    const w = syncWindow(
      { connectedAt, lastSyncedAt: new Date(now.getTime() - 300 * 86_400_000).toISOString() },
      now,
    );
    expect(days(w)).toBe(88);
  });
});
