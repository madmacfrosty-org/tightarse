import { describe, it, expect, vi, afterEach } from "vitest";
import { TrueLayerClient, TrueLayerError, historyFrom, MAX_HISTORY_MONTHS, SANDBOX } from "./index.js";

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
